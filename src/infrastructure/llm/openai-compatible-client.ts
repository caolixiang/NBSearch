import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { runtimeFetch } from "@/infrastructure/http/runtime-fetch"

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://cpabak.zeabur.app/v1"
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = "gpt-5.4-mini"

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return DEFAULT_OPENAI_COMPATIBLE_BASE_URL
  }
  return trimmed.replace(/\/+$/, "")
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
  return createOpenAI({
    name: "openai-compatible",
    baseURL: normalizeBaseUrl(input.baseUrl),
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
