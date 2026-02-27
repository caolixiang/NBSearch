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

export function normalizeGatewayBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) {
    return "http://localhost:8787/v1"
  }

  if (trimmed.endsWith("/v1")) {
    return trimmed
  }

  if (trimmed.endsWith("/v1/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }

  if (trimmed.endsWith("/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }

  return `${trimmed}/v1`
}

export class ProviderRouter {
  private readonly gatewayProvider
  private readonly anthropicProvider

  constructor(private readonly config: AppConfig) {
    this.gatewayProvider = createOpenAI({
      apiKey: config.apiKey || "missing-key",
      baseURL: normalizeGatewayBaseUrl(config.apiBaseUrl),
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
