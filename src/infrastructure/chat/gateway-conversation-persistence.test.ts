import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import {
  createConversationRecord,
  fallbackConversationTitleFromPrompt,
  persistGatewayAssistantTurn,
  upsertGatewayConversationAnchors,
} from "./gateway-conversation-persistence"

describe("gateway conversation persistence", () => {
  it("builds fallback titles from the first non-empty line and truncates long prompts", () => {
    expect(fallbackConversationTitleFromPrompt("\n\nFirst line\nSecond line")).toBe("First line")
    expect(
      fallbackConversationTitleFromPrompt(
        "This is a deliberately long first line that should be clipped before it gets too wide"
      )
    ).toBe("This is a deliberately long first line that shou...")
  })

  it("truncates later turns when regenerating from an earlier assistant", async () => {
    const repository = new MemoryAppRepository()
    await repository.appendMessage("conv_1", {
      id: "user_1",
      role: "user",
      content: "hello",
      createdAt: 1,
    })
    await repository.appendMessage("conv_1", {
      id: "asst_1",
      role: "assistant",
      content: "old answer",
      responseId: "resp_old_1",
      createdAt: 2,
      status: "completed",
    })
    await repository.appendMessage("conv_1", {
      id: "user_2",
      role: "user",
      content: "follow up",
      createdAt: 3,
    })
    await repository.appendMessage("conv_1", {
      id: "asst_2",
      role: "assistant",
      content: "follow up answer",
      responseId: "resp_old_2",
      createdAt: 4,
      status: "completed",
    })

    await persistGatewayAssistantTurn({
      conversationId: "conv_1",
      assistantMessage: {
        id: "asst_1_retry",
        role: "assistant",
        content: "new answer",
        responseId: "resp_new_1",
        createdAt: 5,
        status: "completed",
      },
      anchors: {
        conversationId: "conv_1",
        sessionId: "sess_1",
        lastResponseId: "resp_new_1",
      },
      resolvedTitle: "Greeting",
      commitTime: 6,
      regenerateTargetResponseId: "resp_old_1",
      listMessages: (conversationId) => repository.listMessages(conversationId),
      truncateMessagesAfter: (conversationId, messageId, includeMessage) =>
        repository.truncateMessagesAfter(conversationId, messageId, includeMessage),
      appendMessage: (conversationId, message) => repository.appendMessage(conversationId, message),
      upsertConversation: (record) => repository.upsertConversation(record),
    })

    const messages = await repository.listMessages("conv_1")
    expect(messages.map((message) => message.id)).toEqual(["user_1", "asst_1_retry"])
    const conversation = (await repository.listConversations())[0]
    expect(conversation).toEqual(
      createConversationRecord(
        "conv_1",
        "Greeting",
        {
          conversationId: "conv_1",
          sessionId: "sess_1",
          lastResponseId: "resp_new_1",
        },
        6
      )
    )
  })

  it("preserves the existing title when only anchors are refreshed", async () => {
    const repository = new MemoryAppRepository()
    await repository.upsertConversation({
      id: "conv_anchor_1",
      title: "Existing title",
      anchors: {
        conversationId: "conv_anchor_1",
        sessionId: "sess_old",
      },
      createdAt: 1,
      updatedAt: 2,
    })

    await upsertGatewayConversationAnchors({
      anchors: {
        conversationId: "conv_anchor_1",
        sessionId: "sess_new",
        lastResponseId: "resp_new",
      },
      listConversations: () => repository.listConversations(),
      upsertConversation: (record) => repository.upsertConversation(record),
      now: () => 10,
    })

    const conversation = (await repository.listConversations())[0]
    expect(conversation).toEqual({
      id: "conv_anchor_1",
      title: "Existing title",
      anchors: {
        conversationId: "conv_anchor_1",
        sessionId: "sess_new",
        lastResponseId: "resp_new",
      },
      createdAt: 10,
      updatedAt: 10,
    })
  })
})
