import { afterEach, describe, expect, it, mock } from "bun:test"
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  testOpenAICompatibleConnection,
} from "./openai-compatible-client"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("openai-compatible-client", () => {
  it("uses the expected defaults", () => {
    expect(DEFAULT_OPENAI_COMPATIBLE_BASE_URL).toBe("https://cpabak.zeabur.app/v1")
    expect(DEFAULT_OPENAI_COMPATIBLE_MODEL).toBe("gpt-5.4-mini")
  })

  it("sends a hello prompt and returns the text reply", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      expect(body.model).toBe("gpt-5.4-mini")
      expect(JSON.stringify(body)).toContain("hello")
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test_1",
          object: "chat.completion",
          created: 1779000000,
          model: "gpt-5.4-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "hello back",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const reply = await testOpenAICompatibleConnection({
      baseUrl: "https://cpabak.zeabur.app/v1",
      apiKey: "test-key",
      model: "gpt-5.4-mini",
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(reply).toBe("hello back")
  })
})
