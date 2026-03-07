import { describe, expect, it } from "bun:test"
import { attachRuntimeFetch, createTestGrokChatService } from "./grok-chat-service-test-helpers"

describe("recoverPendingAssistant anchor fallback recovery", () => {
  it("keeps syncing when session anchor advanced but messages are not visible yet", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    const stateUpdatedAt = Date.now()
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_anchor_advanced_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_anchor_advanced_1",
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
      if (url.includes("/v1/sessions/sess_recover_anchor_advanced_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_anchor_advanced_1",
            last_response_id: "resp_server_new_anchor_1",
            in_progress: false,
            active_client_turn_id: null,
            updated_at: stateUpdatedAt,
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
      conversationId: "conv_recover_anchor_advanced_1",
      anchors: {
        sessionId: "sess_recover_anchor_advanced_1",
        lastResponseId: "resp_prev_anchor_advanced_1",
      },
    })

    expect(recovered.recovered).toBe(false)
    expect(recovered.inProgress).toBe(true)
  })

  it("requests retry send when anchor advanced but missing message stays stale", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    await repository.appendMessage("conv_recover_retry_send_1", {
      id: "usr_recover_retry_send_1",
      role: "user",
      content: "请继续",
      createdAt: 1,
      status: "completed",
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_retry_send_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_retry_send_1",
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
      if (url.includes("/v1/sessions/sess_recover_retry_send_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_retry_send_1",
            last_response_id: "resp_server_retry_send_1",
            in_progress: false,
            updated_at: 1,
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
      conversationId: "conv_recover_retry_send_1",
      anchors: {
        sessionId: "sess_recover_retry_send_1",
        lastResponseId: "resp_prev_retry_send_1",
      },
    })

    expect(recovered.recovered).toBe(false)
    expect(recovered.retrySend).toBe(true)
    expect(recovered.inProgress).toBeUndefined()
  })

  it("recovers pending assistant when after_response_id is invalid by falling back to full session messages", async () => {
    const { repository, service } = createTestGrokChatService({
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
    })

    await repository.appendMessage("conv_recover_invalid_after_1", {
      id: "usr_local_1",
      role: "user",
      content: "你好呀",
      createdAt: 1772745093000,
      status: "completed",
    })
    await repository.appendMessage("conv_recover_invalid_after_1", {
      id: "asst_local_1",
      role: "assistant",
      content: "你好呀～",
      responseId: "resp_local_anchor_1",
      createdAt: 1772745093100,
      status: "completed",
    })
    await repository.appendMessage("conv_recover_invalid_after_1", {
      id: "usr_local_2",
      role: "user",
      content: "杭州天气",
      createdAt: 1772745100000,
      status: "completed",
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (
        url.includes("/v1/sessions/sess_recover_invalid_after_1/messages") &&
        url.includes("after_response_id=resp_local_anchor_1")
      ) {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_after_response_id",
              message: "after_response_id not found in session",
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
      if (url.includes("/v1/sessions/sess_recover_invalid_after_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_invalid_after_1",
            messages: [
              {
                role: "user",
                content: "你好呀",
                status: "completed",
                created_at: 1772745093931,
                client_turn_id: "turn_1",
              },
              {
                id: "msg_asst_old_1",
                response_id: "resp_server_old_1",
                role: "assistant",
                content: "你好呀～",
                status: "completed",
                created_at: 1772745093931,
                client_turn_id: "turn_1",
              },
              {
                role: "user",
                content: "杭州天气",
                status: "completed",
                created_at: 1772745106306,
                client_turn_id: "turn_2",
              },
              {
                id: "msg_asst_new_1",
                response_id: "resp_server_new_1",
                role: "assistant",
                content: "杭州天气转晴，15-21℃。",
                status: "completed",
                created_at: 1772745106306,
                client_turn_id: "turn_2",
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
      if (url.includes("/v1/sessions/sess_recover_invalid_after_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_invalid_after_1",
            last_response_id: "resp_server_new_1",
            in_progress: false,
            active_client_turn_id: null,
            updated_at: 1772745106400,
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
      conversationId: "conv_recover_invalid_after_1",
      anchors: {
        sessionId: "sess_recover_invalid_after_1",
        lastResponseId: "resp_local_anchor_1",
      },
    })

    expect(recovered.recovered).toBe(true)
    expect(recovered.result?.assistantMessage.responseId).toBe("resp_server_new_1")
    expect(recovered.result?.assistantMessage.content).toContain("杭州天气转晴")
  })

  it("recovers after completion when session messages become visible with delay", async () => {
    const { repository, service } = createTestGrokChatService()

    let messagesCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_completion_lag_1/messages")) {
        messagesCallCount += 1
        if (messagesCallCount < 3) {
          return new Response(
            JSON.stringify({
              session_id: "sess_recover_completion_lag_1",
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
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_completion_lag_1",
            messages: [
              {
                id: "msg_asst_recover_completion_lag_1",
                response_id: "resp_recover_completion_lag_1",
                role: "assistant",
                content: "Completed after storage delay",
                status: "completed",
                created_at: 1772670001800,
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
      if (url.includes("/v1/sessions/sess_recover_completion_lag_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_completion_lag_1",
            in_progress: false,
            last_response_id: "resp_recover_completion_lag_1",
            updated_at: 1772670001801,
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
      conversationId: "conv_recover_completion_lag_1",
      anchors: {
        sessionId: "sess_recover_completion_lag_1",
        lastResponseId: "resp_prev_completion_lag_1",
      },
    })

    expect(recovered.recovered).toBe(true)
    expect(recovered.result?.assistantMessage.content).toContain("Completed after storage delay")
    expect(messagesCallCount).toBeGreaterThanOrEqual(3)
  })
})
