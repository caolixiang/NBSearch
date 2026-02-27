import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import type { AppConfig } from "../../app/contracts"

export type ProviderKind = "gateway" | "anthropic"

export interface ResolvedModel {
  provider: ProviderKind
  modelId: string
  model: LanguageModel
}

function stripAnthropicPrefix(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model
}

export class ProviderRouter {
  private readonly gatewayProvider
  private readonly anthropicProvider

  constructor(private readonly config: AppConfig) {
    this.gatewayProvider = createOpenAI({
      apiKey: config.apiKey || "missing-key",
      baseURL: `${config.apiBaseUrl.replace(/\/$/, "")}/v1`,
      name: "gateway",
    })

    this.anthropicProvider = createAnthropic({
      apiKey: config.anthropicApiKey || "missing-key",
      baseURL: config.anthropicBaseUrl,
    })
  }

  resolve(model: string): ResolvedModel {
    const normalized = model.trim()
    const isAnthropicModel =
      normalized.startsWith("anthropic/") || normalized.startsWith("claude")

    if (isAnthropicModel) {
      const modelId = stripAnthropicPrefix(normalized)
      return {
        provider: "anthropic",
        modelId,
        model: this.anthropicProvider(modelId),
      }
    }

    return {
      provider: "gateway",
      modelId: normalized,
      model: this.gatewayProvider.responses(normalized),
    }
  }
}
