import type { AppRepository } from "../../domain/storage/repository"
import { hasTauriRuntime } from "../../app/runtime-info"
import { MemoryAppRepository } from "./memory/repository"
import { SqliteAppRepository } from "./sqlite/repository"

let repositorySingleton: AppRepository | null = null

export function getAppRepository(): AppRepository {
  if (!repositorySingleton) {
    repositorySingleton = hasTauriRuntime() ? new SqliteAppRepository() : new MemoryAppRepository()
  }
  return repositorySingleton
}
