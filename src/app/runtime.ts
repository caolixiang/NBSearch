import type { AppRuntime } from "./contracts"
import { loadAppConfig } from "./config"
import { AiSdkChatService } from "../infrastructure/chat/ai-sdk-chat-service"
import { getAppRepository } from "../infrastructure/storage/factory"
import { NoopVoiceService } from "../infrastructure/voice/noop-service"

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
        voice: new NoopVoiceService(),
      },
    }
  }
  return runtimeSingleton
}
