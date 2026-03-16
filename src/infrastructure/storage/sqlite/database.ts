import Database from "@tauri-apps/plugin-sql"
import { hasTauriRuntime } from "@/app/runtime-info"
import { SQLITE_MIGRATIONS } from "./migrations"

const LEGACY_DB_URL = "sqlite:chat-app.db"

let dbPromise: Promise<Database> | null = null
let dbUrlPromise: Promise<string> | null = null

type StoragePaths = {
  dbPath: string
}

async function resolveDbUrl(): Promise<string> {
  if (!hasTauriRuntime()) {
    return LEGACY_DB_URL
  }

  if (!dbUrlPromise) {
    dbUrlPromise = import("@tauri-apps/api/core")
      .then(async ({ invoke }) => {
        const paths = await invoke<StoragePaths>("resolve_storage_paths")
        if (paths?.dbPath?.trim()) {
          return `sqlite:${paths.dbPath.trim()}`
        }
        return LEGACY_DB_URL
      })
      .catch(() => LEGACY_DB_URL)
  }

  return dbUrlPromise
}

async function ensureMigrations(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

  const rows = await db.select<{ version: number }[]>("SELECT version FROM schema_migrations")
  const applied = new Set(rows.map((row) => row.version))

  for (const migration of SQLITE_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue
    }
    for (const statement of migration.statements) {
      await db.execute(statement)
    }
    await db.execute(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES ($1, $2, $3)",
      [migration.version, migration.name, Date.now()]
    )
  }
}

export async function getDatabase(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = resolveDbUrl().then((dbUrl) => Database.load(dbUrl))
  }
  const db = await dbPromise
  await ensureMigrations(db)
  return db
}
