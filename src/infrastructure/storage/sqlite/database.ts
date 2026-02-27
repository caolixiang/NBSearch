import Database from "@tauri-apps/plugin-sql"
import { SQLITE_MIGRATIONS } from "./migrations"

const DB_URL = "sqlite:chat-app.db"

let dbPromise: Promise<Database> | null = null

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
    dbPromise = Database.load(DB_URL).then(async (db) => {
      await ensureMigrations(db)
      return db
    })
  }
  return dbPromise
}
