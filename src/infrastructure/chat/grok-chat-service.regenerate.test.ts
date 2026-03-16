import { describe, expect, it } from "bun:test"
import type { ChatTurnResult } from "../../domain/chat/types"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"
import { createStreamingResponse } from "./grok-chat-service-test-helpers"

describe("streamTurn heartbeats and timeout", () => {
  it("resolves regenerate target from session messages before sending", async () => {
    const repository = new MemoryAppRepository()
    await repository.upsertConversation({
      id: "conv_regen_sync_1",
      title: "Friendly Chinese Greeting",
      anchors: {
        conversationId: "conv_regen_sync_1",
        sessionId: "sess_regen_sync_1",
      },
      createdAt: 1,
      updatedAt: 1,
      starred: false,
    })
    await repository.appendMessage("conv_regen_sync_1", {
      id: "usr_regen_sync_1",
      role: "user",
      content: "\u4F60\u597D",
      createdAt: 1,
    })
    await repository.appendMessage("conv_regen_sync_1", {
      id: "asst_regen_sync_local_1",
      role: "assistant",
      content: "\u4F60\u597D\uFF01\u{1f604} \u4ECA\u5929\u8FC7\u5F97\u548B\u6837\u5440\uFF1F",
      responseId: "c1ec99a3-f9c3-44af-8a1c-597ef5e4a9a9",
      createdAt: 2,
      status: "completed",
    })

    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/sessions/sess_regen_sync_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_regen_sync_1",
            messages: [
              {
                role: "user",
                content: "\u4F60\u597D",
                created_at: 1,
                client_turn_id: "turn_1",
              },
              {
                role: "assistant",
                content: "\u4F60\u597D\uFF01\u{1f604} \u4ECA\u5929\u8FC7\u5F97\u548B\u6837\u5440\uFF1F",
                response_id: "21ba32de-5d23-4d9b-8764-222990a10c12",
                previous_response_id: "0bf30fa6-def6-419f-bc85-10d53de4dde1",
                created_at: 2,
                client_turn_id: "turn_1",
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
      if (url.endsWith("/sessions/sess_regen_sync_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_regen_sync_1",
            last_response_id: "21ba32de-5d23-4d9b-8764-222990a10c12",
            in_progress: false,
            updated_at: 3,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      throw new Error("unexpected fetch: " + url)
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const resolved = await service.resolveRegenerateTarget({
      conversationId: "conv_regen_sync_1",
      sessionId: "sess_regen_sync_1",
      messageId: "asst_regen_sync_local_1",
    })

    expect(resolved).toEqual({
      responseId: "21ba32de-5d23-4d9b-8764-222990a10c12",
      previousResponseId: "0bf30fa6-def6-419f-bc85-10d53de4dde1",
    })

    const messages = await repository.listMessages("conv_regen_sync_1")
    expect(messages[1]?.responseId).toBe("21ba32de-5d23-4d9b-8764-222990a10c12")
    expect(messages[1]?.previousResponseId).toBe("0bf30fa6-def6-419f-bc85-10d53de4dde1")

    const conversation = (await repository.listConversations()).find((item) => item.id === "conv_regen_sync_1")
    expect(conversation?.anchors.lastResponseId).toBe("21ba32de-5d23-4d9b-8764-222990a10c12")
  })

  it("clips later turns when regenerating the first assistant turn", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const requestBodies: string[] = []
    const streamChunks = [
      [
        JSON.stringify({ type: "response.created", response: { id: "resp_old_1" } }),
        JSON.stringify({ type: "response.output_text.delta", delta: "Answer one" }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_old_1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Answer one" }],
              },
            ],
          },
        }),
      ].join(""),
      [
        JSON.stringify({ type: "response.created", response: { id: "resp_old_2" } }),
        JSON.stringify({ type: "response.output_text.delta", delta: "Answer two" }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_old_2",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Answer two" }],
              },
            ],
          },
        }),
      ].join(""),
      [
        JSON.stringify({ type: "response.created", response: { id: "resp_new_1" } }),
        JSON.stringify({ type: "response.output_text.delta", delta: "Answer one regenerated" }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_new_1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Answer one regenerated" }],
              },
            ],
          },
        }),
      ].join(""),
    ]

    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      const nextChunk = streamChunks.shift()
      if (!nextChunk) {
        throw new Error("unexpected request")
      }
      return createStreamingResponse([nextChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    let firstCompleted!: ChatTurnResult
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "Question one",
        anchors: {
          conversationId: "conv_regen_clip_1",
          sessionId: "sess_regen_clip_1",
        },
      },
      (event) => {
        if (event.type === "completed") {
          firstCompleted = event.result
        }
      }
    )
    expect(firstCompleted.assistantMessage.responseId).toBe("resp_old_1")

    let secondCompleted!: ChatTurnResult
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "Question two",
        anchors: firstCompleted.anchors,
      },
      (event) => {
        if (event.type === "completed") {
          secondCompleted = event.result
        }
      }
    )
    expect(secondCompleted.assistantMessage.responseId).toBe("resp_old_2")

    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "",
        anchors: secondCompleted.anchors,
        regenerateTargetResponseId: firstCompleted.assistantMessage.responseId,
      },
      () => {}
    )

    expect(requestBodies).toHaveLength(3)
    const regenerateBody = JSON.parse(requestBodies[2] || "{}") as Record<string, unknown>
    expect(regenerateBody["x_grok"]).toEqual({
      regenerate: true,
      target_response_id: "resp_old_1",
    })

    const messages = await repository.listMessages("conv_regen_clip_1")
    expect(messages.map((item) => ({ role: item.role, content: item.content, responseId: item.responseId || "" }))).toEqual([
      { role: "user", content: "Question one", responseId: "" },
      { role: "assistant", content: "Answer one regenerated", responseId: "resp_new_1" },
    ])

    const conversation = (await repository.listConversations()).find((item) => item.id === "conv_regen_clip_1")
    expect(conversation?.anchors.lastResponseId).toBe("resp_new_1")
  })

  it("sends x_grok regenerate payload without appending a new user message", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_regen_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Regenerated",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_regen_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Regenerated",
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
        text: "",
        anchors: {
          conversationId: "conv_regen_1",
          sessionId: "sess_regen_1",
          lastResponseId: "resp_parent_1",
        },
        regenerateTargetResponseId: "resp_target_3",
      },
      () => {}
    )

    expect(requestBodies).toHaveLength(1)
    const body = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(body["session_id"]).toBe("sess_regen_1")
    expect(body["input"]).toBeUndefined()
    expect(body["previous_response_id"]).toBeUndefined()
    expect(body["x_grok"]).toEqual({
      regenerate: true,
      target_response_id: "resp_target_3",
    })

    const messages = await repository.listMessages("conv_regen_1")
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe("assistant")
    expect(messages[0]?.content).toContain("Regenerated")
  })

})
