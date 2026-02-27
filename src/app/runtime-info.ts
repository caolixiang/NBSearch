export interface RuntimeInfo {
  isTauri: boolean
  appVersion: string
  platform: string
  appDataDir: string
  appLogDir: string
}

interface RuntimeInfoPayload {
  appVersion: string
  platform: string
  appDataDir: string
  appLogDir: string
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__ !== "undefined"
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (!hasTauriRuntime()) {
    return {
      isTauri: false,
      appVersion: "web-dev",
      platform: "web",
      appDataDir: "",
      appLogDir: "",
    }
  }

  const { invoke } = await import("@tauri-apps/api/core")
  const payload = await invoke<RuntimeInfoPayload>("runtime_info")

  return {
    isTauri: true,
    appVersion: payload.appVersion || "unknown",
    platform: payload.platform || "unknown",
    appDataDir: payload.appDataDir || "",
    appLogDir: payload.appLogDir || "",
  }
}
