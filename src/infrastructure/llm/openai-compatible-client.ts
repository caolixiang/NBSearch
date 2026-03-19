import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { runtimeFetch } from "@/infrastructure/http/runtime-fetch"

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://cpabak.zeabur.app/v1"
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-5.4-mini"

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "")
}

function normalizeModel(model: string): string {
  const trimmed = model.trim()
  return trimmed || DEFAULT_OPENAI_COMPATIBLE_MODEL
}

export function createOpenAICompatibleProvider(input: {
  baseUrl: string
  apiKey: string
  fetchFn?: typeof fetch
}) {
  const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error("openai_base_url_missing")
  }
  return createOpenAI({
    name: "openai-compatible",
    baseURL: normalizedBaseUrl,
    apiKey: input.apiKey.trim(),
    fetch: input.fetchFn || runtimeFetch,
  })
}

export async function testOpenAICompatibleConnection(input: {
  baseUrl: string
  apiKey: string
  model: string
  fetchFn?: typeof fetch
}): Promise<string> {
  const provider = createOpenAICompatibleProvider(input)
  const { text } = await generateText({
    model: provider.chat(normalizeModel(input.model)),
    maxOutputTokens: 80,
    prompt: "hello",
  })
  return text.trim()
}
