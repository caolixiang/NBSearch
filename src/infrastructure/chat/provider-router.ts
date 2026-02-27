import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import type { AppConfig } from "../../app/contracts"

export const GATEWAY_SESSION_ID_METADATA_KEY = "__gateway_session_id"

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readSessionIdFromMetadata(payload: Record<string, unknown>): string {
  if (!isRecord(payload.metadata)) {
    return ""
  }
  const raw = payload.metadata[GATEWAY_SESSION_ID_METADATA_KEY]
  return typeof raw === "string" ? raw.trim() : ""
}

export function injectGatewaySessionId(rawBody: string): string {
  try {
    const payload = JSON.parse(rawBody)
    if (!isRecord(payload)) {
      return rawBody
    }

    if (typeof payload.session_id === "string" && payload.session_id.trim()) {
      return rawBody
    }

    const sessionId = readSessionIdFromMetadata(payload)
    if (!sessionId) {
      return rawBody
    }

    payload.session_id = sessionId
    return JSON.stringify(payload)
  } catch {
    return rawBody
  }
}

function createGatewayFetch(baseFetch: typeof fetch): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const method = request.method.toUpperCase()
    if (method !== "POST" || !request.url.includes("/responses")) {
      return baseFetch(request)
    }

    const contentType = request.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      return baseFetch(request)
    }

    const rawBody = await request.text()
    const nextBody = injectGatewaySessionId(rawBody)
    const nextRequest = new Request(request, {
      body: nextBody,
    })
    return baseFetch(nextRequest)
  }
  return wrapped as unknown as typeof fetch
}

export class ProviderRouter {
  private readonly gatewayProvider
  private readonly anthropicProvider

  constructor(private readonly config: AppConfig) {
    this.gatewayProvider = createOpenAI({
      apiKey: config.apiKey || "missing-key",
      baseURL: normalizeGatewayBaseUrl(config.apiBaseUrl),
      name: "gateway",
      fetch: createGatewayFetch(fetch),
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
