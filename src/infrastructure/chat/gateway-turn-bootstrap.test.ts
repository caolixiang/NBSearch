import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"
import { bootstrapGatewayTurn } from "./gateway-turn-bootstrap"

describe("bootstrapGatewayTurn", () => {
  it("prepares conversation record and appends user message for a normal turn", async () => {
    const appended: Array<{ conversationId: string; message: ChatMessage }> = []
    const upserted: ConversationRecord[] = []

    const result = await bootstrapGatewayTurn({
      turnInput: {
        model: "grok-4.1-fast",
        text: "hello world",
        anchors: {
          conversationId: "conv_1",
          lastResponseId: "resp_prev_1",
        },
      },
      listConversations: async () => [],
      upsertConversation: async (record) => {
        upserted.push(record)
      },
      appendMessage: async (conversationId, message) => {
        appended.push({ conversationId, message })
      },
      createConversationRecord: (conversationId, title, anchors, now) => ({
        id: conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
        starred: false,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => `title:${prompt}`,
      createSessionId: () => "sess_generated_1",
      createClientTurnId: () => "turn_generated_1",
      now: () => 100,
    })

    expect(result).toEqual({
      conversationId: "conv_1",
      anchoredSessionId: "",
      sessionId: "sess_generated_1",
      clientTurnId: "turn_generated_1",
      regenerateTargetResponseId: "",
      isRegenerate: false,
      fallbackPreviousResponseId: "resp_prev_1",
      currentTitle: "",
      fallbackTitle: "title:hello world",
    })
    expect(upserted).toEqual([
      {
        id: "conv_1",
        title: "",
        anchors: {
          sessionId: "sess_generated_1",
          conversationId: "conv_1",
          lastResponseId: "resp_prev_1",
        },
        createdAt: 100,
        updatedAt: 100,
        starred: false,
      },
    ])
    expect(appended).toHaveLength(1)
    expect(appended[0]?.conversationId).toBe("conv_1")
    expect(appended[0]?.message.role).toBe("user")
    expect(appended[0]?.message.content).toContain("hello world")
  })

  it("keeps existing title and skips append for regenerate/retryExistingUserMessage", async () => {
    const appended: Array<{ conversationId: string; message: ChatMessage }> = []
    const upserted: ConversationRecord[] = []

    const result = await bootstrapGatewayTurn({
      turnInput: {
        model: "grok-4.1-fast",
        text: "regenerate me",
        anchors: {
          conversationId: "conv_2",
          sessionId: "sess_existing_1",
          lastResponseId: "resp_prev_2",
        },
        clientTurnId: "turn_existing_1",
        regenerateTargetResponseId: "resp_target_1",
        retryExistingUserMessage: true,
      },
      listConversations: async () => [
        {
          id: "conv_2",
          title: "Existing title",
          anchors: {},
          createdAt: 1,
          updatedAt: 2,
          starred: false,
        },
      ],
      upsertConversation: async (record) => {
        upserted.push(record)
      },
      appendMessage: async (conversationId, message) => {
        appended.push({ conversationId, message })
      },
      createConversationRecord: (conversationId, title, anchors, now) => ({
        id: conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
        starred: false,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => `fallback:${prompt}`,
      now: () => 200,
    })

    expect(result).toEqual({
      conversationId: "conv_2",
      anchoredSessionId: "sess_existing_1",
      sessionId: "sess_existing_1",
      clientTurnId: "turn_existing_1",
      regenerateTargetResponseId: "resp_target_1",
      isRegenerate: true,
      fallbackPreviousResponseId: "resp_prev_2",
      currentTitle: "Existing title",
      fallbackTitle: "fallback:regenerate me",
    })
    expect(upserted[0]?.title).toBe("Existing title")
    expect(appended).toHaveLength(0)
  })
})
