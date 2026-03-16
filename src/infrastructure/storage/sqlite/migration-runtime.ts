import { SQLITE_MIGRATIONS, type SqlMigration } from "./migrations"

export interface SqliteMigrationDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>
  select<T>(query: string, bindValues?: unknown[]): Promise<T>
}

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

  const rows = await db.select<Array<{ version: number }>>(
    "SELECT version FROM schema_migrations ORDER BY version ASC"
  )
  const applied = new Set(rows.map((row) => row.version))

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue
    }
    await applySqliteMigration(db, migration, now())
  }
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
