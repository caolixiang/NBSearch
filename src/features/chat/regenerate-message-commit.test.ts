import { describe, expect, it } from "bun:test"
import type { ChatAnchors, ChatMessage } from "@/domain/chat/types"
import type { ConversationRecord } from "@/domain/storage/repository"
import { MemoryAppRepository } from "@/infrastructure/storage/memory/repository"
import { commitRegeneratedAssistantMessage } from "./regenerate-message-commit"

function buildAssistantMessage(id: string, responseId: string, previousResponseId: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: `assistant:${id}`,
    responseId,
    previousResponseId,
    createdAt: 3,
  }
}

describe("commitRegeneratedAssistantMessage", () => {
  it("replaces the regenerated branch before reloading messages", async () => {
    const repository = new MemoryAppRepository()
    const conversation: ConversationRecord = {
      id: "conv_regen_1",
      title: "测试重生成",
      starred: true,
      anchors: {
        sessionId: "sess_regen_1",
        conversationId: "conv_regen_1",
        lastResponseId: "resp_old_2",
      },
      createdAt: 100,
      updatedAt: 200,
    }
    await repository.upsertConversation(conversation)
    await repository.appendMessage(conversation.id, {
      id: "user_1",
      role: "user",
      content: "原问题",
      createdAt: 1,
    })
    await repository.appendMessage(conversation.id, buildAssistantMessage("assistant_old_1", "resp_old_1", ""))
    await repository.appendMessage(conversation.id, {
      id: "user_2",
      role: "user",
      content: "后续问题",
      createdAt: 2,
    })
    await repository.appendMessage(conversation.id, buildAssistantMessage("assistant_old_2", "resp_old_2", "resp_old_1"))

    const nextAnchors: Partial<ChatAnchors> = {
      sessionId: "sess_regen_1",
      conversationId: "conv_regen_1",
      lastResponseId: "resp_new_1",
    }

    await commitRegeneratedAssistantMessage({
      repository,
      conversationId: conversation.id,
      targetAssistantId: "assistant_old_1",
      assistantMessage: buildAssistantMessage("assistant_new_1", "resp_new_1", ""),
      anchors: nextAnchors,
      fallbackConversation: conversation,
      now: 300,
    })

    const messages = await repository.listMessages(conversation.id)
    expect(messages.map((item) => item.id)).toEqual(["user_1", "assistant_new_1"])

    const updatedConversation = (await repository.listConversations()).find((item) => item.id === conversation.id)
    expect(updatedConversation?.title).toBe("测试重生成")
    expect(updatedConversation?.anchors.lastResponseId).toBe("resp_new_1")
    expect(updatedConversation?.updatedAt).toBe(300)
    expect(updatedConversation?.starred).toBe(true)
  })
})
