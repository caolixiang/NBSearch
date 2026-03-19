import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"
import {
  attachRuntimeFetch,
  createStreamingResponse,
  createTestGrokChatService,
  readHeaderValue,
} from "./grok-chat-service-test-helpers"

describe("streamTurn recovery and retry", () => {
  it("recovers completed turn from session APIs after transport failure", async () => {
    const { repository, service } = createTestGrokChatService()

    const requestBodies: string[] = []
    const idempotencyKeys: string[] = []
    let fetchCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        idempotencyKeys.push(readHeaderValue(init?.headers, "Idempotency-Key"))
        throw new Error("network_failed")
      }
      if (url.includes("/v1/sessions/sess_recover_1/turns/turn_recover_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_1",
            client_turn_id: "turn_recover_1",
            status: "completed",
            response_id: "resp_recovered_1",
            updated_at: 1772670000001,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_1",
            messages: [
              {
                id: "resp_recovered_1",
                response_id: "resp_recovered_1",
                previous_response_id: "resp_prev_recover_1",
                role: "assistant",
                content: "Recovered from session API",
                status: "completed",
                client_turn_id: "turn_recover_1",
                created_at: 1772670000000,
              },
            ],
            has_more: false,
            next_after_response_id: "resp_recovered_1",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_1",
            last_response_id: "resp_recovered_1",
            in_progress: false,
            updated_at: 1772670000002,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    attachRuntimeFetch(service, mockedFetch)

    const events: Array<{ type: string; code?: string; result?: { assistantMessage?: { content: string } } }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "recover me",
        anchors: {
          conversationId: "conv_recover_1",
          sessionId: "sess_recover_1",
          lastResponseId: "resp_prev_recover_1",
        },
        clientTurnId: "turn_recover_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(fetchCallCount).toBeGreaterThanOrEqual(4)
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const completed = events.find((event) => event.type === "completed")
    expect(completed?.result?.assistantMessage?.content).toContain("Recovered from session API")
    const requestPayload = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(requestPayload["client_turn_id"]).toBe("turn_recover_1")
    expect(idempotencyKeys[0]).toBe("turn_recover_1")
  })

  it("retries original send once when turn status is not_found after transport failure", async () => {
    const { repository, service } = createTestGrokChatService()

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_retry_notfound_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Retry succeeded",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry_notfound_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Retry succeeded",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    let fetchCallCount = 0
    const requestBodies: string[] = []
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        if (requestBodies.length === 1) {
          throw new Error("network_failed")
        }
        return createStreamingResponse([streamChunk])
      }
      if (url.includes("/v1/sessions/sess_retry_notfound_1/turns/turn_retry_notfound_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_notfound_1",
            client_turn_id: "turn_retry_notfound_1",
            status: "not_found",
            updated_at: 1772670000100,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    attachRuntimeFetch(service, mockedFetch)

    const events: Array<{ type: string }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "retry not found",
        anchors: {
          conversationId: "conv_retry_notfound_1",
          sessionId: "sess_retry_notfound_1",
          lastResponseId: "resp_prev_retry_notfound_1",
        },
        clientTurnId: "turn_retry_notfound_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(fetchCallCount).toBe(3)
    expect(requestBodies).toHaveLength(2)
    const firstBody = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    const secondBody = JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>
    expect(firstBody["client_turn_id"]).toBe("turn_retry_notfound_1")
    expect(secondBody["client_turn_id"]).toBe("turn_retry_notfound_1")
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const messages = await repository.listMessages("conv_retry_notfound_1")
    expect(messages.filter((item) => item.role === "user")).toHaveLength(1)
    expect(messages.filter((item) => item.role === "assistant")).toHaveLength(1)
  })

  it("retries same client turn when recovery reports in_progress and then succeeds", async () => {
    const { repository, service } = createTestGrokChatService()

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_retry_inprogress_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Recovered after in-progress",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry_inprogress_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Recovered after in-progress",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const requestBodies: string[] = []
    let responsesCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        responsesCallCount += 1
        if (responsesCallCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "session_in_progress",
                message: "session has an active turn",
                type: "invalid_request_error",
              },
            }),
            {
              status: 409,
              headers: {
                "Content-Type": "application/json",
              },
            }
          )
        }
        return createStreamingResponse([streamChunk])
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_1/turns/turn_retry_inprogress_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_1",
            client_turn_id: "turn_retry_inprogress_1",
            status: "in_progress",
            updated_at: 1772670000200,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_1",
            last_response_id: "resp_prev_retry_inprogress_1",
            in_progress: true,
            active_client_turn_id: "turn_retry_inprogress_1",
            updated_at: 1772670000201,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    attachRuntimeFetch(service, mockedFetch)

    const events: Array<{ type: string; code?: string }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "recover from in progress",
        anchors: {
          conversationId: "conv_retry_inprogress_1",
          sessionId: "sess_retry_inprogress_1",
          lastResponseId: "resp_prev_retry_inprogress_1",
        },
        clientTurnId: "turn_retry_inprogress_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(requestBodies).toHaveLength(2)
    const firstBody = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    const secondBody = JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>
    expect(firstBody["client_turn_id"]).toBe("turn_retry_inprogress_1")
    expect(secondBody["client_turn_id"]).toBe("turn_retry_inprogress_1")
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
  })

  it("returns turn_in_progress immediately when configured in-progress retry budget is 0", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      openaiApiBaseUrl: "https://cpabak.zeabur.app/v1",
      openaiApiKey: "",
      openaiTranslationModel: "gpt-5.4-mini",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
      turnInProgressRetryMaxAttempts: 0,
      turnInProgressRetryDelayMs: 0,
    })

    const requestBodies: string[] = []
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        return new Response(
          JSON.stringify({
            error: {
              code: "session_in_progress",
              message: "session has an active turn",
              type: "invalid_request_error",
            },
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_fail_1/turns/turn_retry_inprogress_fail_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_fail_1",
            client_turn_id: "turn_retry_inprogress_fail_1",
            status: "in_progress",
            updated_at: 1772670000300,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_fail_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_fail_1",
            last_response_id: "resp_prev_retry_inprogress_fail_1",
            in_progress: true,
            active_client_turn_id: "turn_retry_inprogress_fail_1",
            updated_at: 1772670000301,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    attachRuntimeFetch(service, mockedFetch)

    const events: Array<{ type: string; code?: string }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "in progress forever",
        anchors: {
          conversationId: "conv_retry_inprogress_fail_1",
          sessionId: "sess_retry_inprogress_fail_1",
          lastResponseId: "resp_prev_retry_inprogress_fail_1",
        },
        clientTurnId: "turn_retry_inprogress_fail_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(requestBodies).toHaveLength(1)
    const failed = events.find((event) => event.type === "failed")
    expect(failed?.code).toBe("turn_in_progress")
  })
})
