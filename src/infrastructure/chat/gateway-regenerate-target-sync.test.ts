import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import { syncGatewayRegenerateTarget } from "./gateway-regenerate-target-sync"

describe("syncGatewayRegenerateTarget", () => {
  it("returns empty ids when the target assistant is missing", async () => {
    const repository = new MemoryAppRepository()

    const result = await syncGatewayRegenerateTarget({
      conversationId: "conv_missing",
      sessionId: "sess_missing",
      messageId: "asst_missing",
      listMessages: (conversationId) => repository.listMessages(conversationId),
      updateMessage: (conversationId, message) => repository.updateMessage(conversationId, message),
      listConversations: () => repository.listConversations(),
      upsertConversation: (record) => repository.upsertConversation(record),
      querySessionMessages: async () => [],
      querySessionState: async () => null,
    })

    expect(result).toEqual({
      responseId: "",
      previousResponseId: "",
    })
  })

  it("syncs assistant ids and refreshes the conversation anchor from gateway state", async () => {
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
    })
    await repository.appendMessage("conv_regen_sync_1", {
      id: "usr_regen_sync_1",
      role: "user",
      content: "你好",
      createdAt: 1,
    })
    await repository.appendMessage("conv_regen_sync_1", {
      id: "asst_regen_sync_local_1",
      role: "assistant",
      content: "你好！今天过得咋样呀？",
      responseId: "resp_local_1",
      createdAt: 2,
      status: "completed",
    })

    const result = await syncGatewayRegenerateTarget({
      conversationId: "conv_regen_sync_1",
      sessionId: "sess_regen_sync_1",
      messageId: "asst_regen_sync_local_1",
      listMessages: (conversationId) => repository.listMessages(conversationId),
      updateMessage: (conversationId, message) => repository.updateMessage(conversationId, message),
      listConversations: () => repository.listConversations(),
      upsertConversation: (record) => repository.upsertConversation(record),
      querySessionMessages: async () => [
        {
          id: "usr_gateway_1",
          responseId: "",
          previousResponseId: "",
          role: "user",
          content: "你好",
          status: "completed",
          createdAt: 1,
          clientTurnId: "turn_1",
        },
        {
          id: "asst_gateway_1",
          responseId: "resp_gateway_1",
          previousResponseId: "resp_prev_gateway_1",
          role: "assistant",
          content: "你好！今天过得咋样呀？",
          status: "completed",
          createdAt: 2,
          clientTurnId: "turn_1",
        },
      ],
      querySessionState: async () => ({
        sessionId: "sess_regen_sync_1",
        lastResponseId: "resp_gateway_1",
        inProgress: false,
        activeClientTurnId: "",
        updatedAt: 3,
      }),
      now: () => 10,
    })

    expect(result).toEqual({
      responseId: "resp_gateway_1",
      previousResponseId: "resp_prev_gateway_1",
    })

    const messages = await repository.listMessages("conv_regen_sync_1")
    expect(messages[1]?.responseId).toBe("resp_gateway_1")
    expect(messages[1]?.previousResponseId).toBe("resp_prev_gateway_1")

    const conversation = (await repository.listConversations())[0]
    expect(conversation).toEqual({
      id: "conv_regen_sync_1",
      title: "Friendly Chinese Greeting",
      anchors: {
        conversationId: "conv_regen_sync_1",
        sessionId: "sess_regen_sync_1",
        lastResponseId: "resp_gateway_1",
      },
      createdAt: 1,
      updatedAt: 10,
    })
  })
})
