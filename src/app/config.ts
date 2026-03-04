import type { AppConfig, AppFontSizeMode, AppThemeMode } from "./contracts"
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
  theme?: string
  fontSize?: string
  configPath?: string
}

interface AppearanceConfigPayload {
  theme?: string
  fontSize?: string
  configPath?: string
}

function normalizeThemeMode(value: string | undefined): AppThemeMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (normalized === "dark" || normalized === "system") {
    return normalized
  }
  return "light"
}

function normalizeFontSizeMode(value: string | undefined): AppFontSizeMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (normalized === "small" || normalized === "large") {
    return normalized
  }
  return "default"
}

function readEnvAppConfig(): AppConfig {
  return {
    apiBaseUrl: import.meta.env.VITE_APP_API_BASE_URL?.trim() || "http://localhost:8787",
    apiKey: import.meta.env.VITE_APP_API_KEY?.trim() || "",
    defaultModel: import.meta.env.VITE_APP_DEFAULT_MODEL?.trim() || "grok-4.1-fast",
    voiceEnabled: parseBool(import.meta.env.VITE_APP_VOICE_ENABLED, true),
    themeMode: normalizeThemeMode(import.meta.env.VITE_APP_THEME_MODE),
    fontSizeMode: normalizeFontSizeMode(import.meta.env.VITE_APP_FONT_SIZE_MODE),
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

export async function saveAppearanceConfigToToml(input: {
  themeMode: AppThemeMode
  fontSizeMode: AppFontSizeMode
}): Promise<AppearanceConfigPayload | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<AppearanceConfigPayload>("save_appearance_config", {
      theme: input.themeMode,
      fontSize: input.fontSizeMode,
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
  const fileThemeMode = normalizeThemeMode(fileConfig?.theme)
  const fileFontSizeMode = normalizeFontSizeMode(fileConfig?.fontSize)
  const hasFileTheme = typeof fileConfig?.theme === "string" && fileConfig.theme.trim().length > 0
  const hasFileFontSize =
    typeof fileConfig?.fontSize === "string" && fileConfig.fontSize.trim().length > 0

  return {
    ...envConfig,
    // config.toml has higher priority than .env in all environments.
    apiBaseUrl: fileApiBaseUrl || envConfig.apiBaseUrl,
    apiKey: fileApiKey || envConfig.apiKey,
    themeMode: hasFileTheme ? fileThemeMode : envConfig.themeMode,
    fontSizeMode: hasFileFontSize ? fileFontSizeMode : envConfig.fontSizeMode,
  }
}
