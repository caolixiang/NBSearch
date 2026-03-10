import type { AppFontSizeMode, AppRuntime, AppThemeMode } from "./contracts"
import { loadAppConfig } from "./config"
import { GrokChatService } from "../infrastructure/chat/grok-chat-service"
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
        voice: new GatewayVoiceService(config),
      },
    }
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
