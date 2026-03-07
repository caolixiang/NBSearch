import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"
import type { GatewaySessionMessage, GatewaySessionState, GatewayTurnState } from "./gateway-session-recovery"
import { persistRecoveredCompletedTurnFromGateway } from "./gateway-recovered-turn-persistence"

function assistantRow(input: {
  id?: string
  responseId: string
  content: string
  createdAt: number
  previousResponseId?: string
}): GatewaySessionMessage {
  return {
    id: input.id || input.responseId,
    responseId: input.responseId,
    previousResponseId: input.previousResponseId || "",
    role: "assistant",
    content: input.content,
    status: "completed",
    createdAt: input.createdAt,
    clientTurnId: "turn_1",
  }
}

function turnState(input: Partial<GatewayTurnState>): GatewayTurnState {
  return {
    status: input.status || "completed",
    responseId: input.responseId || "resp_1",
    errorCode: input.errorCode || "",
    errorMessage: input.errorMessage || "",
    updatedAt: input.updatedAt ?? 0,
  }
}

function sessionState(input: Partial<GatewaySessionState>): GatewaySessionState {
  return {
    sessionId: input.sessionId || "sess_1",
    lastResponseId: input.lastResponseId || "",
    inProgress: input.inProgress ?? false,
    activeClientTurnId: input.activeClientTurnId || "",
    updatedAt: input.updatedAt ?? 0,
  }
}

function conversationRecord(title = ""): ConversationRecord {
  return {
    id: "conv_1",
    title,
    anchors: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("persistRecoveredCompletedTurnFromGateway", () => {
  it("returns null when turn state has no response id", async () => {
    const result = await persistRecoveredCompletedTurnFromGateway({
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnState: turnState({ responseId: "" }),
      fallbackPreviousResponseId: "resp_prev_1",
      listMessages: async () => [],
      listConversations: async () => [],
      updateMessage: async () => undefined,
      appendMessage: async () => undefined,
      upsertConversation: async () => undefined,
      querySessionMessages: async () => [],
      querySessionState: async () => null,
      createConversationRecord: (title, anchors, now) => ({
        id: anchors.conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => prompt.slice(0, 12),
    })

    expect(result).toBeNull()
  })

  it("appends recovered assistant and falls back to prompt-derived title", async () => {
    const appended: ChatMessage[] = []
    const updated: ChatMessage[] = []
    const conversations: ConversationRecord[] = []

    const result = await persistRecoveredCompletedTurnFromGateway({
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnState: turnState({ responseId: "resp_done_1" }),
      fallbackPreviousResponseId: "resp_prev_1",
      listMessages: async () => [],
      listConversations: async () => [],
      updateMessage: async (message) => {
        updated.push(message)
      },
      appendMessage: async (message) => {
        appended.push(message)
      },
      upsertConversation: async (record) => {
        conversations.push(record)
      },
      querySessionMessages: async () => [
        assistantRow({ responseId: "resp_done_1", content: "Recovered answer", createdAt: 2 }),
      ],
      querySessionState: async () => sessionState({ lastResponseId: "resp_done_1" }),
      createConversationRecord: (title, anchors, now) => ({
        id: anchors.conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => `title:${prompt}`,
      now: () => 99,
      createAssistantMessageId: () => "asst_generated_1",
    })

    expect(updated).toHaveLength(0)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.id).toBe("resp_done_1")
    expect(appended[0]?.content).toBe("Recovered answer")
    expect(appended[0]?.previousResponseId).toBe("resp_prev_1")
    expect(conversations).toEqual([
      {
        id: "conv_1",
        title: "title:Recovered answer",
        anchors: {
          sessionId: "sess_1",
          conversationId: "conv_1",
          lastResponseId: "resp_done_1",
        },
        createdAt: 99,
        updatedAt: 99,
      },
    ])
    expect(result?.assistantMessage.responseId).toBe("resp_done_1")
    expect(result?.anchors.lastResponseId).toBe("resp_done_1")
  })

  it("updates existing assistant when recovered content changes", async () => {
    const existingAssistant: ChatMessage = {
      id: "asst_local_1",
      role: "assistant",
      content: "old answer",
      createdAt: 5,
      responseId: "resp_done_1",
      previousResponseId: "resp_prev_old",
      status: "streaming",
      reasoningDurationSeconds: 8,
      reasoningEvents: [],
      research: {
        details: [],
      },
    }
    const updated: ChatMessage[] = []

    const result = await persistRecoveredCompletedTurnFromGateway({
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnState: turnState({ responseId: "resp_done_1" }),
      fallbackPreviousResponseId: "resp_prev_1",
      listMessages: async () => [existingAssistant],
      listConversations: async () => [conversationRecord("Existing title")],
      updateMessage: async (message) => {
        updated.push(message)
      },
      appendMessage: async () => undefined,
      upsertConversation: async () => undefined,
      querySessionMessages: async () => [
        assistantRow({
          id: "msg_remote_1",
          responseId: "resp_done_1",
          content: "new answer",
          previousResponseId: "resp_prev_new",
          createdAt: 10,
        }),
      ],
      querySessionState: async () => sessionState({ lastResponseId: "resp_done_1" }),
      createConversationRecord: (title, anchors, now) => ({
        id: anchors.conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => prompt,
      now: () => 100,
    })

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      id: "asst_local_1",
      content: "new answer",
      previousResponseId: "resp_prev_new",
      status: "completed",
      reasoningDurationSeconds: 8,
    })
    expect(result?.assistantMessage.id).toBe("asst_local_1")
  })

  it("uses latest assistant fallback when exact response id is missing", async () => {
    const appended: ChatMessage[] = []

    const result = await persistRecoveredCompletedTurnFromGateway({
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnState: turnState({ responseId: "resp_target_1" }),
      fallbackPreviousResponseId: "resp_prev_1",
      listMessages: async () => [],
      listConversations: async () => [],
      updateMessage: async () => undefined,
      appendMessage: async (message) => {
        appended.push(message)
      },
      upsertConversation: async () => undefined,
      querySessionMessages: async () => [
        assistantRow({ responseId: "resp_other_1", content: "older", createdAt: 2 }),
        assistantRow({ responseId: "resp_other_2", content: "latest", createdAt: 3 }),
      ],
      querySessionState: async () => sessionState({}),
      createConversationRecord: (title, anchors, now) => ({
        id: anchors.conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => prompt,
      now: () => 101,
    })

    expect(appended).toHaveLength(1)
    expect(appended[0]?.content).toBe("latest")
    expect(appended[0]?.responseId).toBe("resp_target_1")
    expect(result?.assistantMessage.content).toBe("latest")
  })

  it("returns null when no assistant candidate is available", async () => {
    const result = await persistRecoveredCompletedTurnFromGateway({
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnState: turnState({ responseId: "resp_done_1" }),
      fallbackPreviousResponseId: "resp_prev_1",
      listMessages: async () => [],
      listConversations: async () => [],
      updateMessage: async () => undefined,
      appendMessage: async () => undefined,
      upsertConversation: async () => undefined,
      querySessionMessages: async () => [],
      querySessionState: async () => null,
      createConversationRecord: (title, anchors, now) => ({
        id: anchors.conversationId,
        title,
        anchors,
        createdAt: now,
        updatedAt: now,
      }),
      fallbackConversationTitleFromPrompt: (prompt) => prompt,
    })

    expect(result).toBeNull()
  })
})
