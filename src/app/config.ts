import type { AppConfig } from "./contracts"
import { hasTauriRuntime } from "./runtime-info"

function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (!input) {
    return fallback
  }
  const value = input.trim().toLowerCase()
  if (value === "true") {
    return true
  }
  if (value === "false") {
    return false
  }
  return fallback
}

interface GatewayConfigPayload {
  apiBaseUrl?: string
  apiKey?: string
  configPath?: string
}

function readEnvAppConfig(): AppConfig {
  return {
    apiBaseUrl: import.meta.env.VITE_APP_API_BASE_URL?.trim() || "http://localhost:8787",
    apiKey: import.meta.env.VITE_APP_API_KEY?.trim() || "",
    defaultModel: import.meta.env.VITE_APP_DEFAULT_MODEL?.trim() || "grok-4.1-fast",
    voiceEnabled: parseBool(import.meta.env.VITE_APP_VOICE_ENABLED, true),
  }
}

function normalizeGatewayValue(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

async function readGatewayConfigFromToml(): Promise<GatewayConfigPayload | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<GatewayConfigPayload>("read_gateway_config")
  } catch {
    return null
  }
}

export async function saveGatewayConfigToToml(input: {
  apiBaseUrl: string
  apiKey: string
}): Promise<GatewayConfigPayload | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<GatewayConfigPayload>("save_gateway_config", {
      apiBaseUrl: normalizeGatewayValue(input.apiBaseUrl),
      apiKey: normalizeGatewayValue(input.apiKey),
    })
  } catch {
    return null
  }
}

export async function loadAppConfig(): Promise<AppConfig> {
  const envConfig = readEnvAppConfig()
  const fileConfig = await readGatewayConfigFromToml()
  const fileApiBaseUrl = normalizeGatewayValue(fileConfig?.apiBaseUrl)
  const fileApiKey = normalizeGatewayValue(fileConfig?.apiKey)

  return {
    ...envConfig,
    // config.toml has higher priority than .env in all environments.
    apiBaseUrl: fileApiBaseUrl || envConfig.apiBaseUrl,
    apiKey: fileApiKey || envConfig.apiKey,
  }
}
