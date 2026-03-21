import { afterEach, describe, expect, it } from "bun:test"
import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SqlMigration } from "./migrations"
import { SQLITE_MIGRATIONS } from "./migrations"
import { ensureSqliteMigrations, type SqliteMigrationDatabase } from "./migration-runtime"

const LEGACY_FIXTURE_SQL = readFileSync(
  new URL("./fixtures/legacy-v1.sql", import.meta.url),
  "utf8"
)
const LEGACY_V2_DEEPSEARCH_FIXTURE_SQL = readFileSync(
  new URL("./fixtures/legacy-v2-deepsearch.sql", import.meta.url),
  "utf8"
)

const tempDirs: string[] = []

function normalizeSql(query: string): string {
  return query.replace(/\$(\d+)/g, "?$1")
}

class BunSqliteMigrationAdapter implements SqliteMigrationDatabase {
  constructor(private readonly db: BunSqliteDatabase) {}

  async execute(query: string, bindValues: unknown[] = []): Promise<void> {
    if (bindValues.length === 0) {
      this.db.exec(query)
      return
    }
    this.db.query(normalizeSql(query)).run(...(bindValues as any[]))
  }

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
    return this.db.query(normalizeSql(query)).all(...(bindValues as any[])) as T
  }
}

function createTempDb(): BunSqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), "nbsearch-sqlite-migration-"))
  tempDirs.push(dir)
  return new BunSqliteDatabase(join(dir, "fixture.db"))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) {
      continue
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("ensureSqliteMigrations", () => {
  it("upgrades a legacy v1 fixture without losing existing conversations", async () => {
    const db = createTempDb()
    db.exec(LEGACY_FIXTURE_SQL)

    const adapter = new BunSqliteMigrationAdapter(db)
    await ensureSqliteMigrations(adapter, {
      now: () => 1774000000000,
    })
    await ensureSqliteMigrations(adapter, {
      now: () => 1775000000000,
    })

    const columns = db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain("starred")

    const conversations = db
      .query("SELECT id, title, starred FROM conversations ORDER BY updated_at DESC")
      .all() as Array<{ id: string; title: string; starred: number }>
    expect(conversations).toEqual([
      {
        id: "conv_fixture_newer",
        title: "旧对话二",
        starred: 0,
      },
      {
        id: "conv_fixture_older",
        title: "旧对话一",
        starred: 0,
      },
    ])

    const versions = db
      .query("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number }>
    expect(versions.map((row) => row.version)).toEqual([1, 2, 4, 5, 6])

    db.close()
  })

  it("rolls back a failed migration transaction without leaving partial schema changes", async () => {
    const db = new BunSqliteDatabase(":memory:")
    const adapter = new BunSqliteMigrationAdapter(db)
    const migrations: SqlMigration[] = [
      {
        version: 1,
        name: "create_demo",
        statements: ["CREATE TABLE demo (id INTEGER PRIMARY KEY)"],
      },
      {
        version: 2,
        name: "broken_demo_upgrade",
        statements: [
          "ALTER TABLE demo ADD COLUMN note TEXT DEFAULT ''",
          "INSERT INTO demo(id, note) VALUES (1, 'before failure')",
          "THIS IS INVALID SQL",
        ],
      },
    ]

    await expect(
      ensureSqliteMigrations(adapter, {
        migrations,
        now: () => 1776000000000,
      })
    ).rejects.toThrow()

    const versions = db
      .query("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number }>
    expect(versions.map((row) => row.version)).toEqual([1])

    const columns = db.query("PRAGMA table_info(demo)").all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(["id"])

    const rows = db.query("SELECT * FROM demo").all() as unknown[]
    expect(rows).toHaveLength(0)

    db.close()
  })

  it("repairs legacy v2 deepsearch databases that collide with the reused migration version", async () => {
    const db = createTempDb()
    db.exec(LEGACY_V2_DEEPSEARCH_FIXTURE_SQL)

    const adapter = new BunSqliteMigrationAdapter(db)
    await ensureSqliteMigrations(adapter, {
      now: () => 1777000000000,
    })
    await ensureSqliteMigrations(adapter, {
      now: () => 1778000000000,
    })

    const columns = db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain("starred")

    const conversations = db
      .query("SELECT id, title, starred FROM conversations ORDER BY updated_at DESC")
      .all() as Array<{ id: string; title: string; starred: number }>
    expect(conversations).toEqual([
      {
        id: "conv_fixture_upgrade",
        title: "旧版本升级对话",
        starred: 0,
      },
    ])

    const versions = db
      .query("SELECT version, name FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number; name: string }>
    expect(versions).toEqual([
      { version: 1, name: "init_chat_schema" },
      { version: 2, name: "add_conversation_has_deep_search_flag" },
      { version: 3, name: "repair_conversation_starred_after_version_conflict" },
      { version: 4, name: "add_feed_subscription_tables" },
      { version: 5, name: "add_feed_item_translation_fields" },
      { version: 6, name: "reset_legacy_feed_items_for_gateway_schema" },
    ])

    db.close()
  })

  it("clears legacy feed items and resets polling when upgrading to migration 6", async () => {
    const db = createTempDb()
    const adapter = new BunSqliteMigrationAdapter(db)

    await ensureSqliteMigrations(adapter, {
      migrations: SQLITE_MIGRATIONS.filter((migration) => migration.version <= 5),
      now: () => 1779000000000,
    })

    db.query(
      "INSERT INTO feed_subscriptions(id, source, enabled, poll_interval_minutes, last_polled_at, last_success_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("feed_sub_polymarket", "polymarket", 1, 10, 1000, 1000, "old error", 1, 1)
    db.query(
      "INSERT INTO feed_items(id, subscription_id, source, content_hash, title, content_markdown, title_zh, content_markdown_zh, translation_status, translation_model, translated_at, media_json, canonical_url, published_at, discovered_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "feed_item_polymarket_1",
      "feed_sub_polymarket",
      "polymarket",
      "hash_1",
      "Old title",
      "Old body",
      "",
      "",
      "skipped",
      "",
      null,
      "[]",
      "https://x.com/Polymarket/status/1",
      1,
      1,
      1
    )

    await ensureSqliteMigrations(adapter, {
      now: () => 1780000000000,
    })

    const feedCount = db.query("SELECT COUNT(*) AS count FROM feed_items").get() as { count: number }
    const subscription = db.query(
      "SELECT poll_interval_minutes, last_polled_at, last_success_at, last_error FROM feed_subscriptions WHERE source = ?"
    ).get("polymarket") as {
      poll_interval_minutes: number
      last_polled_at: number | null
      last_success_at: number | null
      last_error: string
    }

    expect(feedCount.count).toBe(0)
    expect(subscription).toEqual({
      poll_interval_minutes: 30,
      last_polled_at: null,
      last_success_at: null,
      last_error: "",
    })

    db.close()
  })
})
