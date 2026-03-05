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
  turnInProgressRetryMaxAttempts?: number
  turnInProgressRetryDelayMs?: number
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

function normalizeRetryMaxAttempts(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.min(10, Math.floor(value))
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(10, parsed)
    }
  }
  return fallback
}

function normalizeRetryDelayMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.min(30_000, Math.floor(value))
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(30_000, parsed)
    }
  }
  return fallback
}

const DEFAULT_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS = 1
const DEFAULT_TURN_IN_PROGRESS_RETRY_DELAY_MS = 600

function readEnvAppConfig(): AppConfig {
  const useEnvGatewayDefaults = import.meta.env.DEV
  const envApiBaseUrl = import.meta.env.VITE_APP_API_BASE_URL?.trim() || ""
  const envApiKey = import.meta.env.VITE_APP_API_KEY?.trim() || ""
  return {
    // Never embed gateway defaults in production bundles to avoid leaking local keys/endpoints.
    apiBaseUrl: useEnvGatewayDefaults ? envApiBaseUrl || "http://localhost:8787" : "",
    apiKey: useEnvGatewayDefaults ? envApiKey : "",
    defaultModel: import.meta.env.VITE_APP_DEFAULT_MODEL?.trim() || "grok-4.1-fast",
    voiceEnabled: parseBool(import.meta.env.VITE_APP_VOICE_ENABLED, true),
    themeMode: normalizeThemeMode(import.meta.env.VITE_APP_THEME_MODE),
    fontSizeMode: normalizeFontSizeMode(import.meta.env.VITE_APP_FONT_SIZE_MODE),
    turnInProgressRetryMaxAttempts: normalizeRetryMaxAttempts(
      import.meta.env.VITE_APP_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS,
      DEFAULT_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS
    ),
    turnInProgressRetryDelayMs: normalizeRetryDelayMs(
      import.meta.env.VITE_APP_TURN_IN_PROGRESS_RETRY_DELAY_MS,
      DEFAULT_TURN_IN_PROGRESS_RETRY_DELAY_MS
    ),
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
  const fileRetryMaxAttempts = normalizeRetryMaxAttempts(
    fileConfig?.turnInProgressRetryMaxAttempts,
    envConfig.turnInProgressRetryMaxAttempts ?? DEFAULT_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS
  )
  const fileRetryDelayMs = normalizeRetryDelayMs(
    fileConfig?.turnInProgressRetryDelayMs,
    envConfig.turnInProgressRetryDelayMs ?? DEFAULT_TURN_IN_PROGRESS_RETRY_DELAY_MS
  )
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
    turnInProgressRetryMaxAttempts: fileRetryMaxAttempts,
    turnInProgressRetryDelayMs: fileRetryDelayMs,
  }
}
