import type { ChatService } from "../domain/chat/service"
import type { AppRepository } from "../domain/storage/repository"
import type { VoiceService } from "../domain/voice/service"

export interface AppConfig {
  apiBaseUrl: string
  apiKey: string
  defaultModel: string
  voiceEnabled: boolean
  anthropicApiKey?: string
  anthropicBaseUrl?: string
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
