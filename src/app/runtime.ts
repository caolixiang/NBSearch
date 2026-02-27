import type { AppRuntime } from "./contracts"
import { loadAppConfig } from "./config"
import { AiSdkChatService } from "../infrastructure/chat/ai-sdk-chat-service"
import { getAppRepository } from "../infrastructure/storage/factory"
import { GatewayVoiceService } from "../infrastructure/voice/gateway-voice-service"

let runtimeSingleton: AppRuntime | null = null

export function getAppRuntime(): AppRuntime {
  if (!runtimeSingleton) {
    const config = loadAppConfig()
    const repository = getAppRepository()
    runtimeSingleton = {
      config,
      services: {
        repository,
        chat: new AiSdkChatService(repository, config),
        voice: new GatewayVoiceService(config),
      },
    }
  }
  return runtimeSingleton
}
