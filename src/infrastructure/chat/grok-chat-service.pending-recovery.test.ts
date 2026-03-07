import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"
import { attachRuntimeFetch, createTestGrokChatService } from "./grok-chat-service-test-helpers"

describe("recoverPendingAssistant", () => {
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
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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

  it("keeps syncing when session anchor advanced but messages are not visible yet", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
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
