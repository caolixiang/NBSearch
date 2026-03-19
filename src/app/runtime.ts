import type { AppFontSizeMode, AppRuntime, AppThemeMode } from "./contracts"
import { loadAppConfig } from "./config"
import { GrokChatService } from "../infrastructure/chat/grok-chat-service"
import { PolymarketFeedService } from "../infrastructure/feed/polymarket-feed-service"
import { getAppRepository } from "../infrastructure/storage/factory"
import { GatewayVoiceService } from "../infrastructure/voice/gateway-voice-service"

let runtimeSingleton: AppRuntime | null = null
let runtimeLoadingPromise: Promise<AppRuntime> | null = null

export async function getAppRuntime(): Promise<AppRuntime> {
  if (runtimeSingleton) {
    return runtimeSingleton
  }
  if (runtimeLoadingPromise) {
    return runtimeLoadingPromise
  }

  runtimeLoadingPromise = (async () => {
    const config = await loadAppConfig()
    const repository = getAppRepository()
    runtimeSingleton = {
      config,
      services: {
        repository,
        chat: new GrokChatService(repository, config),
        feeds: new PolymarketFeedService(repository, config),
        voice: new GatewayVoiceService(config),
      },
    }
    runtimeSingleton.services.feeds.ensureStarted()
    return runtimeSingleton
  })()

  return runtimeLoadingPromise
}

export function applyGatewayConfigToRuntime(next: { apiBaseUrl: string; apiKey: string }): void {
  if (!runtimeSingleton) {
    return
  }
  runtimeSingleton.config.apiBaseUrl = next.apiBaseUrl
  runtimeSingleton.config.apiKey = next.apiKey
  const repository = runtimeSingleton.services.repository
  runtimeSingleton.services.chat = new GrokChatService(repository, runtimeSingleton.config)
  runtimeSingleton.services.voice = new GatewayVoiceService(runtimeSingleton.config)
}

export function applyLlmConfigToRuntime(next: {
  llmApiBaseUrl: string
  llmApiKey: string
  llmTranslationModel: string
}): void {
  if (!runtimeSingleton) {
    return
  }
  runtimeSingleton.config.llmApiBaseUrl = next.llmApiBaseUrl
  runtimeSingleton.config.llmApiKey = next.llmApiKey
  runtimeSingleton.config.llmTranslationModel = next.llmTranslationModel
}

export function applyAppearanceConfigToRuntime(next: {
  themeMode: AppThemeMode
  fontSizeMode: AppFontSizeMode
}): void {
  if (!runtimeSingleton) {
    return
  }
  runtimeSingleton.config.themeMode = next.themeMode
  runtimeSingleton.config.fontSizeMode = next.fontSizeMode
}

export function applyPersonalizationConfigToRuntime(next: { timezone: string }): void {
  if (!runtimeSingleton) {
    return
  }
  runtimeSingleton.config.timezone = next.timezone
}

export function applySubscriptionsConfigToRuntime(next: {
  polymarketSubscriptionEnabled: boolean
}): void {
  if (!runtimeSingleton) {
    return
  }
  runtimeSingleton.config.polymarketSubscriptionEnabled = next.polymarketSubscriptionEnabled
  runtimeSingleton.services.feeds.applyConfig({
    polymarketEnabled: next.polymarketSubscriptionEnabled,
  })
}
