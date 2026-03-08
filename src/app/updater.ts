import { hasTauriRuntime } from "./runtime-info"

export interface AppUpdateCheckResult {
  enabled: boolean
  available: boolean
  currentVersion: string
  version?: string
  notes?: string
  pubDate?: string
  error?: string
}

export interface AppUpdateInstallResult {
  enabled: boolean
  installed: boolean
  currentVersion: string
  version?: string
  error?: string
}

export interface AppUpdatePrepareResult {
  enabled: boolean
  available: boolean
  downloaded: boolean
  currentVersion: string
  version?: string
  notes?: string
  pubDate?: string
  error?: string
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<AppUpdateCheckResult>("check_app_update")
  } catch {
    return {
      enabled: false,
      available: false,
      currentVersion: "unknown",
      error: "check_failed",
    }
  }
}

export async function prepareAppUpdate(): Promise<AppUpdatePrepareResult | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<AppUpdatePrepareResult>("prepare_app_update")
  } catch {
    return {
      enabled: false,
      available: false,
      downloaded: false,
      currentVersion: "unknown",
      error: "prepare_failed",
    }
  }
}

export async function installPreparedAppUpdate(): Promise<AppUpdateInstallResult | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<AppUpdateInstallResult>("install_prepared_app_update")
  } catch {
    return {
      enabled: false,
      installed: false,
      currentVersion: "unknown",
      error: "install_failed",
    }
  }
}

export async function installAppUpdate(): Promise<AppUpdateInstallResult | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<AppUpdateInstallResult>("install_app_update")
  } catch {
    return {
      enabled: false,
      installed: false,
      currentVersion: "unknown",
      error: "install_failed",
    }
  }
}
