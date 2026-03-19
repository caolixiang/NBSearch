import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"
import {
  createPendingStreamingResponse,
  createStreamingResponse,
  readHeaderValue,
} from "./grok-chat-service-test-helpers"

describe("streamTurn heartbeats and timeout", () => {
  it("emits heartbeat and monotonic meta sequence on a normal stream", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_meta_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Hello",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_meta_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Hello",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const mockedFetch = (async () => createStreamingResponse([streamChunk])) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{
      type: string
      meta: { seq: number; conversationId: string; responseId?: string }
      code?: string
      result?: { assistantMessage?: { content: string } }
    }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "hello",
        anchors: {
          conversationId: "conv_meta_1",
          sessionId: "sess_meta_1",
          lastResponseId: "",
        },
      },
      (event) => {
        events.push(event)
      }
    )

    expect(events.length).toBeGreaterThan(0)
    expect(events.some((event) => event.type === "heartbeat")).toBe(true)
    expect(events.some((event) => event.type === "completed")).toBe(true)

    for (let index = 0; index < events.length; index += 1) {
      expect(events[index]?.meta.seq).toBe(index + 1)
      expect(events[index]?.meta.conversationId).toBe("conv_meta_1")
    }

    const completedEvent = events.find((event) => event.type === "completed")
    expect(completedEvent?.meta.responseId).toBe("resp_meta_1")
    expect(completedEvent?.result?.assistantMessage?.content).toContain("Hello")
  })

  it("emits stream_idle_timeout failure when stream reader stalls", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        return createPendingStreamingResponse()
      }
      return new Response(
        JSON.stringify({
          status: "not_found",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      return originalSetTimeout(() => {
        if (typeof handler === "function") {
          handler()
        }
      }, 0)
    }) as unknown as typeof setTimeout

    const events: Array<{ type: string; code?: string }> = []
    try {
      await service.streamTurn(
        {
          model: "grok-4.1-fast",
          text: "hello",
          anchors: {
            conversationId: "conv_timeout_1",
            sessionId: "sess_timeout_1",
            lastResponseId: "",
          },
        },
        (event) => {
          events.push(event)
        }
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    const failed = events.find((event) => event.type === "failed")
    expect(failed?.code).toBe("stream_idle_timeout")
    expect(events.some((event) => event.type === "completed")).toBe(false)
  })

  it("retries once on initial idle timeout and keeps idempotent client_turn_id", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_retry_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Recovered",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Recovered",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    let fetchCallCount = 0
    const requestBodies: string[] = []
    const idempotencyKeys: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      idempotencyKeys.push(readHeaderValue(init?.headers, "Idempotency-Key"))
      if (fetchCallCount === 1) {
        return createPendingStreamingResponse()
      }
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      return originalSetTimeout(() => {
        if (typeof handler === "function") {
          handler()
        }
      }, 0)
    }) as unknown as typeof setTimeout

    const events: Array<{ type: string; code?: string; result?: { assistantMessage?: { content: string } } }> = []
    try {
      await service.streamTurn(
        {
          model: "grok-4.1-fast",
          text: "retry please",
          anchors: {
            conversationId: "conv_retry_1",
            sessionId: "sess_retry_1",
            lastResponseId: "resp_prev_42",
          },
        },
        (event) => {
          events.push(event)
        }
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(fetchCallCount).toBe(2)
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const completed = events.find((event) => event.type === "completed")
    expect(completed?.result?.assistantMessage?.content).toContain("Recovered")

    const parsedRequestBodies = requestBodies
      .map((raw) => {
        try {
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .filter((payload) => Object.keys(payload).length > 0)
    expect(parsedRequestBodies).toHaveLength(2)
    const firstClientTurnId = (parsedRequestBodies[0]?.["client_turn_id"] as string) || ""
    const secondClientTurnId = (parsedRequestBodies[1]?.["client_turn_id"] as string) || ""
    expect(firstClientTurnId.length > 0).toBe(true)
    expect(secondClientTurnId).toBe(firstClientTurnId)
    expect(parsedRequestBodies.every((payload) => payload["previous_response_id"] === undefined)).toBe(true)
    expect(idempotencyKeys).toEqual([firstClientTurnId, firstClientTurnId])
  })

  it("does not retry idle timeout when configured retry budget is 0", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
      streamIdleRetryMaxAttempts: 0,
      streamIdleRetryDelayMs: 0,
    })

    let fetchCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        fetchCallCount += 1
        return createPendingStreamingResponse()
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      return originalSetTimeout(() => {
        if (typeof handler === "function") {
          handler()
        }
      }, 0)
    }) as unknown as typeof setTimeout

    const events: Array<{ type: string; code?: string }> = []
    try {
      await service.streamTurn(
        {
          model: "grok-4.1-fast",
          text: "no idle retry",
          anchors: {
            conversationId: "conv_no_idle_retry_1",
            sessionId: "sess_no_idle_retry_1",
            lastResponseId: "resp_prev_no_idle_retry_1",
          },
        },
        (event) => {
          events.push(event)
        }
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(fetchCallCount).toBe(1)
    const failed = events.find((event) => event.type === "failed")
    expect(failed?.code).toBe("stream_idle_timeout")
  })

  it("retries once without previous_response_id on session anchor conflict", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_anchor_retry_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Recovered",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_anchor_retry_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Recovered",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    let fetchCallCount = 0
    const requestBodies: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      if (fetchCallCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "session_anchor_conflict",
              message: "previous_response_id does not match session anchor",
              type: "invalid_request_error",
            },
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{ type: string; code?: string; result?: { assistantMessage?: { content: string } } }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "retry please",
        anchors: {
          conversationId: "conv_anchor_retry_1",
          lastResponseId: "resp_prev_anchor_42",
        },
      },
      (event) => {
        events.push(event)
      }
    )

    expect(fetchCallCount).toBe(2)
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const completed = events.find((event) => event.type === "completed")
    expect(completed?.result?.assistantMessage?.content).toContain("Recovered")

    expect(requestBodies).toHaveLength(2)
    const firstBody = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    const secondBody = JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>
    expect(firstBody["previous_response_id"]).toBe("resp_prev_anchor_42")
    expect(secondBody["previous_response_id"]).toBeUndefined()
  })

  it("sends previous_response_id when only response anchor is provided", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_no_session_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Answer",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_no_session_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Answer",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const requestBodies: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "hello",
        anchors: {
          conversationId: "conv_no_session_1",
          lastResponseId: "resp_prev_should_not_send",
        },
      },
      () => {}
    )

    expect(requestBodies).toHaveLength(1)
    const body = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(typeof body["session_id"]).toBe("string")
    expect(body["previous_response_id"]).toBe("resp_prev_should_not_send")
  })

})
