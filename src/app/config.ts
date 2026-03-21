import type { AppConfig, AppFontSizeMode, AppThemeMode } from "./contracts"
import { DEFAULT_APP_TIMEZONE, normalizeAppTimezone } from "./personalization"
import { hasTauriRuntime } from "./runtime-info"
import { normalizeFeedCustomAccounts } from "@/domain/feed/source-config"
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
} from "@/infrastructure/llm/openai-compatible-client"

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
  openaiApiBaseUrl?: string
  openaiApiKey?: string
  openaiTranslationModel?: string
  theme?: string
  fontSize?: string
  timezone?: string
  polymarketEnabled?: boolean
  kalshiEnabled?: boolean
  customAccounts?: string[]
  streamIdleTimeoutMs?: number
  streamIdleRetryMaxAttempts?: number
  streamIdleRetryDelayMs?: number
  turnRecoveryMessagesLimit?: number
  turnRecoveryNotFoundRetryMaxAttempts?: number
  turnRecoveryPollInProgressMaxAttempts?: number
  turnRecoveryPollInProgressDelayMs?: number
  turnInProgressRetryMaxAttempts?: number
  turnInProgressRetryDelayMs?: number
  configPath?: string
}

interface AppearanceConfigPayload {
  theme?: string
  fontSize?: string
  configPath?: string
}

interface OpenAIConfigPayload {
  openaiApiBaseUrl?: string
  openaiApiKey?: string
  openaiTranslationModel?: string
  configPath?: string
}

interface PersonalizationConfigPayload {
  timezone?: string
  configPath?: string
}

interface SubscriptionsConfigPayload {
  polymarketEnabled?: boolean
  kalshiEnabled?: boolean
  customAccounts?: string[]
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

function normalizeIntegerInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.min(max, Math.max(min, Math.floor(value)))
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(max, Math.max(min, parsed))
    }
  }
  return fallback
}

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 20_000
const DEFAULT_STREAM_IDLE_RETRY_MAX_ATTEMPTS = 1
const DEFAULT_STREAM_IDLE_RETRY_DELAY_MS = 450
const DEFAULT_OPENAI_TRANSLATION_MODEL = DEFAULT_OPENAI_COMPATIBLE_MODEL
const DEFAULT_TURN_RECOVERY_MESSAGES_LIMIT = 100
const DEFAULT_TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS = 1
const DEFAULT_TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS = 2
const DEFAULT_TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS = 700
const DEFAULT_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS = 1
const DEFAULT_TURN_IN_PROGRESS_RETRY_DELAY_MS = 600

function readEnvAppConfig(): AppConfig {
  const useEnvGatewayDefaults = import.meta.env.DEV
  const envApiBaseUrl = import.meta.env.VITE_APP_API_BASE_URL?.trim() || ""
  const envApiKey = import.meta.env.VITE_APP_API_KEY?.trim() || ""
  const envOpenAIApiBaseUrl = import.meta.env.VITE_APP_OPENAI_API_BASE_URL?.trim() || ""
  const envOpenAIApiKey = import.meta.env.VITE_APP_OPENAI_API_KEY?.trim() || ""
  const envOpenAITranslationModel = import.meta.env.VITE_APP_OPENAI_TRANSLATION_MODEL?.trim() || ""
  const envFeedCustomAccounts = normalizeFeedCustomAccounts(import.meta.env.VITE_APP_FEED_CUSTOM_ACCOUNTS)
  return {
    // Never embed gateway defaults in production bundles to avoid leaking local keys/endpoints.
    apiBaseUrl: useEnvGatewayDefaults ? envApiBaseUrl || "http://localhost:8787" : "",
    apiKey: useEnvGatewayDefaults ? envApiKey : "",
    defaultModel: import.meta.env.VITE_APP_DEFAULT_MODEL?.trim() || "grok-4.1-fast",
    openaiApiBaseUrl: envOpenAIApiBaseUrl,
    openaiApiKey: envOpenAIApiKey,
    openaiTranslationModel: envOpenAITranslationModel || DEFAULT_OPENAI_TRANSLATION_MODEL,
    voiceEnabled: parseBool(import.meta.env.VITE_APP_VOICE_ENABLED, true),
    polymarketSubscriptionEnabled: parseBool(import.meta.env.VITE_APP_POLYMARKET_SUBSCRIPTION_ENABLED, true),
    kalshiSubscriptionEnabled: parseBool(import.meta.env.VITE_APP_KALSHI_SUBSCRIPTION_ENABLED, true),
    feedCustomAccounts: envFeedCustomAccounts,
    themeMode: normalizeThemeMode(import.meta.env.VITE_APP_THEME_MODE),
    fontSizeMode: normalizeFontSizeMode(import.meta.env.VITE_APP_FONT_SIZE_MODE),
    timezone: normalizeAppTimezone(import.meta.env.VITE_APP_TIMEZONE || DEFAULT_APP_TIMEZONE),
    streamIdleTimeoutMs: normalizeIntegerInRange(
      import.meta.env.VITE_APP_STREAM_IDLE_TIMEOUT_MS,
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      1_000,
      120_000
    ),
    streamIdleRetryMaxAttempts: normalizeIntegerInRange(
      import.meta.env.VITE_APP_STREAM_IDLE_RETRY_MAX_ATTEMPTS,
      DEFAULT_STREAM_IDLE_RETRY_MAX_ATTEMPTS,
      0,
      10
    ),
    streamIdleRetryDelayMs: normalizeIntegerInRange(
      import.meta.env.VITE_APP_STREAM_IDLE_RETRY_DELAY_MS,
      DEFAULT_STREAM_IDLE_RETRY_DELAY_MS,
      0,
      30_000
    ),
    turnRecoveryMessagesLimit: normalizeIntegerInRange(
      import.meta.env.VITE_APP_TURN_RECOVERY_MESSAGES_LIMIT,
      DEFAULT_TURN_RECOVERY_MESSAGES_LIMIT,
      1,
      500
    ),
    turnRecoveryNotFoundRetryMaxAttempts: normalizeIntegerInRange(
      import.meta.env.VITE_APP_TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS,
      DEFAULT_TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS,
      0,
      10
    ),
    turnRecoveryPollInProgressMaxAttempts: normalizeIntegerInRange(
      import.meta.env.VITE_APP_TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS,
      DEFAULT_TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS,
      0,
      20
    ),
    turnRecoveryPollInProgressDelayMs: normalizeIntegerInRange(
      import.meta.env.VITE_APP_TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS,
      DEFAULT_TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS,
      0,
      30_000
    ),
    turnInProgressRetryMaxAttempts: normalizeIntegerInRange(
      import.meta.env.VITE_APP_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS,
      DEFAULT_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS,
      0,
      10
    ),
    turnInProgressRetryDelayMs: normalizeIntegerInRange(
      import.meta.env.VITE_APP_TURN_IN_PROGRESS_RETRY_DELAY_MS,
      DEFAULT_TURN_IN_PROGRESS_RETRY_DELAY_MS,
      0,
      30_000
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

export async function saveOpenAIConfigToToml(input: {
  openaiApiBaseUrl: string
  openaiApiKey: string
  openaiTranslationModel: string
}): Promise<OpenAIConfigPayload | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<OpenAIConfigPayload>("save_openai_config", {
      openaiApiBaseUrl: normalizeGatewayValue(input.openaiApiBaseUrl),
      openaiApiKey: normalizeGatewayValue(input.openaiApiKey),
      openaiTranslationModel: normalizeGatewayValue(input.openaiTranslationModel),
    })
  } catch {
    return null
  }
}

export async function savePersonalizationConfigToToml(input: {
  timezone: string
}): Promise<PersonalizationConfigPayload | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<PersonalizationConfigPayload>("save_personalization_config", {
      timezone: normalizeAppTimezone(input.timezone),
    })
  } catch {
    return null
  }
}

export async function saveSubscriptionsConfigToToml(input: {
  polymarketEnabled: boolean
  kalshiEnabled: boolean
  customAccounts: string[]
}): Promise<SubscriptionsConfigPayload | null> {
  if (!hasTauriRuntime()) {
    return null
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<SubscriptionsConfigPayload>("save_subscriptions_config", {
      polymarketEnabled: input.polymarketEnabled,
      kalshiEnabled: input.kalshiEnabled,
      customAccounts: normalizeFeedCustomAccounts(input.customAccounts),
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
  const fileOpenAIApiBaseUrl = normalizeGatewayValue(fileConfig?.openaiApiBaseUrl)
  const fileOpenAIApiKey = normalizeGatewayValue(fileConfig?.openaiApiKey)
  const fileOpenAITranslationModel = normalizeGatewayValue(fileConfig?.openaiTranslationModel)
  const fileThemeMode = normalizeThemeMode(fileConfig?.theme)
  const fileFontSizeMode = normalizeFontSizeMode(fileConfig?.fontSize)
  const fileTimezone = normalizeAppTimezone(fileConfig?.timezone)
  const filePolymarketEnabled =
    typeof fileConfig?.polymarketEnabled === "boolean"
      ? fileConfig.polymarketEnabled
      : envConfig.polymarketSubscriptionEnabled
  const fileKalshiEnabled =
    typeof fileConfig?.kalshiEnabled === "boolean"
      ? fileConfig.kalshiEnabled
      : envConfig.kalshiSubscriptionEnabled
  const fileCustomAccounts = normalizeFeedCustomAccounts(fileConfig?.customAccounts)
  const hasFileCustomAccounts = Array.isArray(fileConfig?.customAccounts)
  const fileStreamIdleTimeoutMs = normalizeIntegerInRange(
    fileConfig?.streamIdleTimeoutMs,
    envConfig.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    1_000,
    120_000
  )
  const fileStreamIdleRetryMaxAttempts = normalizeIntegerInRange(
    fileConfig?.streamIdleRetryMaxAttempts,
    envConfig.streamIdleRetryMaxAttempts ?? DEFAULT_STREAM_IDLE_RETRY_MAX_ATTEMPTS,
    0,
    10
  )
  const fileStreamIdleRetryDelayMs = normalizeIntegerInRange(
    fileConfig?.streamIdleRetryDelayMs,
    envConfig.streamIdleRetryDelayMs ?? DEFAULT_STREAM_IDLE_RETRY_DELAY_MS,
    0,
    30_000
  )
  const fileTurnRecoveryMessagesLimit = normalizeIntegerInRange(
    fileConfig?.turnRecoveryMessagesLimit,
    envConfig.turnRecoveryMessagesLimit ?? DEFAULT_TURN_RECOVERY_MESSAGES_LIMIT,
    1,
    500
  )
  const fileTurnRecoveryNotFoundRetryMaxAttempts = normalizeIntegerInRange(
    fileConfig?.turnRecoveryNotFoundRetryMaxAttempts,
    envConfig.turnRecoveryNotFoundRetryMaxAttempts ?? DEFAULT_TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS,
    0,
    10
  )
  const fileTurnRecoveryPollInProgressMaxAttempts = normalizeIntegerInRange(
    fileConfig?.turnRecoveryPollInProgressMaxAttempts,
    envConfig.turnRecoveryPollInProgressMaxAttempts ?? DEFAULT_TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS,
    0,
    20
  )
  const fileTurnRecoveryPollInProgressDelayMs = normalizeIntegerInRange(
    fileConfig?.turnRecoveryPollInProgressDelayMs,
    envConfig.turnRecoveryPollInProgressDelayMs ?? DEFAULT_TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS,
    0,
    30_000
  )
  const fileRetryMaxAttempts = normalizeIntegerInRange(
    fileConfig?.turnInProgressRetryMaxAttempts,
    envConfig.turnInProgressRetryMaxAttempts ?? DEFAULT_TURN_IN_PROGRESS_RETRY_MAX_ATTEMPTS,
    0,
    10
  )
  const fileRetryDelayMs = normalizeIntegerInRange(
    fileConfig?.turnInProgressRetryDelayMs,
    envConfig.turnInProgressRetryDelayMs ?? DEFAULT_TURN_IN_PROGRESS_RETRY_DELAY_MS,
    0,
    30_000
  )
  const hasFileTheme = typeof fileConfig?.theme === "string" && fileConfig.theme.trim().length > 0
  const hasFileFontSize =
    typeof fileConfig?.fontSize === "string" && fileConfig.fontSize.trim().length > 0
  const hasFileTimezone = typeof fileConfig?.timezone === "string" && fileConfig.timezone.trim().length > 0

  return {
    ...envConfig,
    // config.toml has higher priority than .env in all environments.
    apiBaseUrl: fileApiBaseUrl || envConfig.apiBaseUrl,
    apiKey: fileApiKey || envConfig.apiKey,
    openaiApiBaseUrl: fileOpenAIApiBaseUrl || envConfig.openaiApiBaseUrl,
    openaiApiKey: fileOpenAIApiKey || envConfig.openaiApiKey,
    openaiTranslationModel:
      fileOpenAITranslationModel || envConfig.openaiTranslationModel || DEFAULT_OPENAI_TRANSLATION_MODEL,
    themeMode: hasFileTheme ? fileThemeMode : envConfig.themeMode,
    fontSizeMode: hasFileFontSize ? fileFontSizeMode : envConfig.fontSizeMode,
    timezone: hasFileTimezone ? fileTimezone : envConfig.timezone,
    polymarketSubscriptionEnabled: filePolymarketEnabled,
    kalshiSubscriptionEnabled: fileKalshiEnabled,
    feedCustomAccounts: hasFileCustomAccounts ? fileCustomAccounts : envConfig.feedCustomAccounts,
    streamIdleTimeoutMs: fileStreamIdleTimeoutMs,
    streamIdleRetryMaxAttempts: fileStreamIdleRetryMaxAttempts,
    streamIdleRetryDelayMs: fileStreamIdleRetryDelayMs,
    turnRecoveryMessagesLimit: fileTurnRecoveryMessagesLimit,
    turnRecoveryNotFoundRetryMaxAttempts: fileTurnRecoveryNotFoundRetryMaxAttempts,
    turnRecoveryPollInProgressMaxAttempts: fileTurnRecoveryPollInProgressMaxAttempts,
    turnRecoveryPollInProgressDelayMs: fileTurnRecoveryPollInProgressDelayMs,
    turnInProgressRetryMaxAttempts: fileRetryMaxAttempts,
    turnInProgressRetryDelayMs: fileRetryDelayMs,
  }
}
