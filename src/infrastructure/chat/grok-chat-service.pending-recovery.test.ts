import { describe, expect, it } from "bun:test"
import { attachRuntimeFetch, createTestGrokChatService } from "./grok-chat-service-test-helpers"

describe("recoverPendingAssistant pending state recovery", () => {
  it("recovers pending assistant from session messages without resending", async () => {
    const { repository, service } = createTestGrokChatService()

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_pending_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_1",
            messages: [
              {
                id: "msg_asst_recover_pending_1",
                response_id: "resp_recover_pending_1",
                previous_response_id: "resp_prev_pending_1",
                role: "assistant",
                content: "Recovered pending assistant",
                status: "completed",
                created_at: 1772670001000,
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
      }
      if (url.includes("/v1/sessions/sess_recover_pending_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_1",
            last_response_id: "resp_recover_pending_1",
            in_progress: false,
            updated_at: 1772670001001,
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

    const recovered = await service.recoverPendingAssistant({
      conversationId: "conv_recover_pending_1",
      anchors: {
        sessionId: "sess_recover_pending_1",
        lastResponseId: "resp_prev_pending_1",
      },
    })

    expect(recovered.recovered).toBe(true)
    expect(recovered.result?.assistantMessage.content).toContain("Recovered pending assistant")

    const messages = await repository.listMessages("conv_recover_pending_1")
    expect(messages.filter((item) => item.role === "assistant")).toHaveLength(1)
    expect(messages[0]?.responseId).toBe("resp_recover_pending_1")

    const conversations = await repository.listConversations()
    const conversation = conversations.find((item) => item.id === "conv_recover_pending_1")
    expect(conversation?.anchors.lastResponseId).toBe("resp_recover_pending_1")
  })

  it("reports pending in_progress when pending assistant has not landed yet", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_pending_wait_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_wait_1",
            messages: [],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_pending_wait_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_wait_1",
            last_response_id: "resp_prev_pending_wait_1",
            in_progress: true,
            active_client_turn_id: "turn_pending_wait_1",
            updated_at: 1772670001200,
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

    const recovered = await service.recoverPendingAssistant({
      conversationId: "conv_recover_pending_wait_1",
      anchors: {
        sessionId: "sess_recover_pending_wait_1",
        lastResponseId: "resp_prev_pending_wait_1",
      },
    })

    expect(recovered.recovered).toBe(false)
    expect(recovered.inProgress).toBe(true)
    const messages = await repository.listMessages("conv_recover_pending_wait_1")
    expect(messages).toHaveLength(0)
  })

  it("returns preview content while pending assistant is still streaming", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_pending_preview_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_preview_1",
            messages: [
              {
                id: "msg_asst_recover_pending_preview_1",
                response_id: "resp_recover_pending_preview_1",
                role: "assistant",
                content: "正在同步上游结果...",
                status: "in_progress",
                created_at: 1772670001400,
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
      }
      if (url.includes("/v1/sessions/sess_recover_pending_preview_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_preview_1",
            in_progress: true,
            updated_at: 1772670001401,
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

    const recovered = await service.recoverPendingAssistant({
      conversationId: "conv_recover_pending_preview_1",
      anchors: {
        sessionId: "sess_recover_pending_preview_1",
        lastResponseId: "resp_prev_pending_preview_1",
      },
    })

    expect(recovered.recovered).toBe(false)
    expect(recovered.inProgress).toBe(true)
    expect(recovered.previewContent).toContain("正在同步上游结果")
  })

  it("recovers pending assistant from active turn state before session finishes", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_turn_completed_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_turn_completed_1",
            messages: [
              {
                id: "msg_asst_recover_turn_completed_1",
                response_id: "resp_recover_turn_completed_1",
                previous_response_id: "resp_prev_turn_completed_1",
                role: "assistant",
                content: "Recovered from active turn state",
                status: "completed",
                created_at: 1772670001500,
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
      }
      if (url.includes("/v1/sessions/sess_recover_turn_completed_1/turns/turn_pending_completed_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_turn_completed_1",
            client_turn_id: "turn_pending_completed_1",
            status: "completed",
            response_id: "resp_recover_turn_completed_1",
            updated_at: 1772670001501,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_turn_completed_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_turn_completed_1",
            last_response_id: "resp_recover_turn_completed_1",
            in_progress: true,
            active_client_turn_id: "turn_pending_completed_1",
            updated_at: 1772670001502,
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

    const recovered = await service.recoverPendingAssistant({
      conversationId: "conv_recover_turn_completed_1",
      anchors: {
        sessionId: "sess_recover_turn_completed_1",
        lastResponseId: "resp_prev_turn_completed_1",
      },
    })

    expect(recovered.recovered).toBe(true)
    expect(recovered.result?.assistantMessage.responseId).toBe("resp_recover_turn_completed_1")
    expect(recovered.result?.assistantMessage.content).toContain("Recovered from active turn state")
  })

  it("returns retryable pending state when active turn is not_found", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_turn_notfound_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_turn_notfound_1",
            messages: [],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_turn_notfound_1/turns/turn_pending_notfound_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_turn_notfound_1",
            client_turn_id: "turn_pending_notfound_1",
            status: "not_found",
            updated_at: 1772670001601,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_turn_notfound_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_turn_notfound_1",
            last_response_id: "resp_prev_turn_notfound_1",
            in_progress: true,
            active_client_turn_id: "turn_pending_notfound_1",
            updated_at: 1772670001600,
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

    const recovered = await service.recoverPendingAssistant({
      conversationId: "conv_recover_turn_notfound_1",
      anchors: {
        sessionId: "sess_recover_turn_notfound_1",
        lastResponseId: "resp_prev_turn_notfound_1",
      },
    })

    expect(recovered.recovered).toBe(false)
    expect(recovered.inProgress).toBeUndefined()
  })
})
