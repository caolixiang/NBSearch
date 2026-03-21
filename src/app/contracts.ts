import type { ChatService } from "../domain/chat/service"
import type { FeedService } from "../domain/feed/service"
import type { AppRepository } from "../domain/storage/repository"
import type { VoiceService } from "../domain/voice/service"

export type AppThemeMode = "light" | "dark" | "system"

export type AppFontSizeMode = "small" | "default" | "large"

export interface AppConfig {
  apiBaseUrl: string
  apiKey: string
  defaultModel: string
  openaiApiBaseUrl: string
  openaiApiKey: string
  openaiTranslationModel: string
  voiceEnabled: boolean
  polymarketSubscriptionEnabled?: boolean
  kalshiSubscriptionEnabled?: boolean
  feedCustomAccounts?: string[]
  themeMode: AppThemeMode
  fontSizeMode: AppFontSizeMode
  timezone?: string
  streamIdleTimeoutMs?: number
  streamIdleRetryMaxAttempts?: number
  streamIdleRetryDelayMs?: number
  turnRecoveryMessagesLimit?: number
  turnRecoveryNotFoundRetryMaxAttempts?: number
  turnRecoveryPollInProgressMaxAttempts?: number
  turnRecoveryPollInProgressDelayMs?: number
  turnInProgressRetryMaxAttempts?: number
  turnInProgressRetryDelayMs?: number
}

export interface AppServices {
  chat: ChatService
  feeds: FeedService
  voice: VoiceService
  repository: AppRepository
}

export interface AppRuntime {
  config: AppConfig
  services: AppServices
}
