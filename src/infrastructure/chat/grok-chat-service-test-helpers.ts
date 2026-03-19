import type { AppConfig } from "../../app/contracts"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"

export function createStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
      },
    }
  )
}

export function createPendingStreamingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // Keep stream open to trigger idle timeout path in stream reader.
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
      },
    }
  )
}

export function readHeaderValue(headers: HeadersInit | undefined, key: string): string {
  if (!headers) {
    return ""
  }
  const lower = key.toLowerCase()
  if (headers instanceof Headers) {
    return headers.get(key) || ""
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (name.toLowerCase() === lower) {
        return value
      }
    }
    return ""
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lower) {
      return value
    }
  }
  return ""
}

const DEFAULT_TEST_GROK_CHAT_CONFIG: AppConfig = {
  apiBaseUrl: "http://127.0.0.1:8787",
  apiKey: "test-key",
  defaultModel: "grok-4.1-fast",
      openaiApiBaseUrl: "https://cpabak.zeabur.app/v1",
      openaiApiKey: "",
      openaiTranslationModel: "gpt-5.4-mini",
  voiceEnabled: false,
  themeMode: "light",
  fontSizeMode: "default",
}

export function createTestGrokChatService(overrides: Partial<AppConfig> = {}) {
  const repository = new MemoryAppRepository()
  const service = new GrokChatService(repository, {
    ...DEFAULT_TEST_GROK_CHAT_CONFIG,
    ...overrides,
  })
  return { repository, service }
}


export function attachRuntimeFetch(service: GrokChatService, mockedFetch: typeof fetch): void {
  ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
  ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch
}
