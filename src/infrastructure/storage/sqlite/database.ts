import Database from "@tauri-apps/plugin-sql"
import { hasTauriRuntime } from "@/app/runtime-info"
import { ensureSqliteMigrations } from "./migration-runtime"

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

export async function getDatabase(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = resolveDbUrl().then((dbUrl) => Database.load(dbUrl))
  }
  const db = await dbPromise
  await ensureSqliteMigrations(db)
  return db
}
