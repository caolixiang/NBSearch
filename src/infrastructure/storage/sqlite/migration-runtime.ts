import { SQLITE_MIGRATIONS, type SqlMigration } from "./migrations"

export interface SqliteMigrationDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>
  select<T>(query: string, bindValues?: unknown[]): Promise<T>
}

const LEGACY_DEEPSEARCH_MIGRATION_NAME = "add_conversation_has_deep_search_flag"
const STARRED_REPAIR_MIGRATION_VERSION = 3
const STARRED_REPAIR_MIGRATION_NAME = "repair_conversation_starred_after_version_conflict"

export async function ensureSqliteMigrations(
  db: SqliteMigrationDatabase,
  input: {
    migrations?: SqlMigration[]
    now?: () => number
  } = {}
): Promise<void> {
  const migrations = input.migrations || SQLITE_MIGRATIONS
  const now = input.now || (() => Date.now())

  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const rows = await db.select<Array<{ version: number; name: string }>>(
    "SELECT version, name FROM schema_migrations ORDER BY version ASC"
  )
  const applied = new Set(rows.map((row) => row.version))

  await repairLegacyStarredMigrationConflict(db, rows, applied, now)

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue
    }
    await applySqliteMigration(db, migration, now())
  }
}

async function repairLegacyStarredMigrationConflict(
  db: SqliteMigrationDatabase,
  rows: Array<{ version: number; name: string }>,
  applied: Set<number>,
  now: () => number
): Promise<void> {
  if (applied.has(STARRED_REPAIR_MIGRATION_VERSION)) {
    return
  }

  const hasLegacyDeepsearchMigration = rows.some(
    (row) => row.version === 2 && row.name === LEGACY_DEEPSEARCH_MIGRATION_NAME
  )
  if (!hasLegacyDeepsearchMigration) {
    return
  }

  const hasStarredColumn = await sqliteColumnExists(db, "conversations", "starred")
  const repairMigration: SqlMigration = {
    version: STARRED_REPAIR_MIGRATION_VERSION,
    name: STARRED_REPAIR_MIGRATION_NAME,
    statements: hasStarredColumn
      ? []
      : [
          `ALTER TABLE conversations
           ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
        ],
  }

  await applySqliteMigration(db, repairMigration, now())
  applied.add(STARRED_REPAIR_MIGRATION_VERSION)
}

async function sqliteColumnExists(
  db: SqliteMigrationDatabase,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const normalizedTableName = quoteSqliteIdentifier(tableName)
  const rows = await db.select<Array<{ name?: string }>>(`PRAGMA table_info(${normalizedTableName})`)
  return rows.some((row) => row.name === columnName)
}

function quoteSqliteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQLite identifier: ${value}`)
  }
  return `"${value}"`
}

async function applySqliteMigration(
  db: SqliteMigrationDatabase,
  migration: SqlMigration,
  appliedAt: number
): Promise<void> {
  let started = false
  try {
    await db.execute("BEGIN IMMEDIATE")
    started = true
    for (const statement of migration.statements) {
      await db.execute(statement)
    }
    await db.execute(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES ($1, $2, $3)",
      [migration.version, migration.name, appliedAt]
    )
    await db.execute("COMMIT")
    started = false
  } catch (error) {
    if (started) {
      try {
        await db.execute("ROLLBACK")
      } catch {
        // Ignore rollback failure and surface the original migration error.
      }
    }
    throw error
  }
}
