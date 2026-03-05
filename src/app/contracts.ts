import type { ChatService } from "../domain/chat/service"
import type { AppRepository } from "../domain/storage/repository"
import type { VoiceService } from "../domain/voice/service"

export type AppThemeMode = "light" | "dark" | "system"

export type AppFontSizeMode = "small" | "default" | "large"

export interface AppConfig {
  apiBaseUrl: string
  apiKey: string
  defaultModel: string
  voiceEnabled: boolean
  themeMode: AppThemeMode
  fontSizeMode: AppFontSizeMode
  turnInProgressRetryMaxAttempts?: number
  turnInProgressRetryDelayMs?: number
}

export interface AppServices {
  chat: ChatService
  voice: VoiceService
  repository: AppRepository
}

export interface AppRuntime {
  config: AppConfig
  services: AppServices
}
