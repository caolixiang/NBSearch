import { describe, expect, it } from "bun:test"
import type { ChatMessage, ChatTurnResult } from "../../domain/chat/types"
import type {
  GatewaySessionMessage,
  GatewaySessionState,
  GatewayTurnState,
} from "./gateway-session-recovery"
import { recoverPendingAssistantFromGateway } from "./gateway-pending-assistant-recovery"

function userMessage(createdAt: number): ChatMessage {
  return {
    id: `usr_${createdAt}`,
    role: "user",
    content: "hi",
    createdAt,
  }
}

function assistantRow(input: {
  responseId: string
  content: string
  createdAt: number
  status?: GatewaySessionMessage["status"]
  previousResponseId?: string
}): GatewaySessionMessage {
  return {
    id: input.responseId,
    responseId: input.responseId,
    previousResponseId: input.previousResponseId || "",
    role: "assistant",
    content: input.content,
    status: input.status || "completed",
    createdAt: input.createdAt,
    clientTurnId: "turn_1",
  }
}

function stateRow(input: Partial<GatewaySessionState>): GatewaySessionState {
  return {
    sessionId: input.sessionId || "sess_1",
    lastResponseId: input.lastResponseId || "",
    inProgress: input.inProgress ?? false,
    activeClientTurnId: input.activeClientTurnId || "",
    updatedAt: input.updatedAt ?? 0,
  }
}

const completedTurnResult: ChatTurnResult = {
  assistantMessage: {
    id: "asst_1",
    role: "assistant",
    content: "done",
    createdAt: 3,
    responseId: "resp_1",
    status: "completed",
  },
  anchors: {
    conversationId: "conv_1",
    sessionId: "sess_1",
    lastResponseId: "resp_1",
  },
}

describe("recoverPendingAssistantFromGateway", () => {
  it("recovers immediately from completed assistant messages", async () => {
    const result = await recoverPendingAssistantFromGateway({
      localMessages: [userMessage(1)],
      fallbackPreviousResponseId: "resp_prev_1",
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      completionFetchMaxAttempts: 1,
      completionFetchDelayMs: 0,
      missingMessageRetryAfterMs: 30_000,
      querySessionMessages: async () => [assistantRow({ responseId: "resp_1", content: "done", createdAt: 3 })],
      querySessionState: async () => stateRow({ inProgress: false }),
      queryTurnState: async () => null,
      persistCompletedTurn: async () => completedTurnResult,
    })

    expect(result.recovered).toBe(true)
    expect(result.result).toEqual(completedTurnResult)
    expect(result.previewContent).toBe("done")
  })

  it("returns preview while assistant is still streaming", async () => {
    const result = await recoverPendingAssistantFromGateway({
      localMessages: [userMessage(1)],
      fallbackPreviousResponseId: "resp_prev_1",
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      completionFetchMaxAttempts: 1,
      completionFetchDelayMs: 0,
      missingMessageRetryAfterMs: 30_000,
      querySessionMessages: async () => [
        assistantRow({ responseId: "resp_1", content: "thinking", createdAt: 3, status: "streaming" }),
      ],
      querySessionState: async () => stateRow({ inProgress: true }),
      queryTurnState: async () => null,
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({
      recovered: false,
      inProgress: true,
      previewContent: "thinking",
    })
  })

  it("recovers from active completed turn when messages have not landed yet", async () => {
    const result = await recoverPendingAssistantFromGateway({
      localMessages: [userMessage(1)],
      fallbackPreviousResponseId: "resp_prev_1",
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      completionFetchMaxAttempts: 1,
      completionFetchDelayMs: 0,
      missingMessageRetryAfterMs: 30_000,
      querySessionMessages: async () => [],
      querySessionState: async () => stateRow({ inProgress: true, activeClientTurnId: "turn_1" }),
      queryTurnState: async () => ({
        status: "completed",
        responseId: "resp_1",
        errorCode: "",
        errorMessage: "",
        updatedAt: 3,
      }),
      persistCompletedTurn: async () => completedTurnResult,
    })

    expect(result.recovered).toBe(true)
    expect(result.result).toEqual(completedTurnResult)
  })

  it("requests retrySend when anchor advanced and missing message stays stale", async () => {
    const result = await recoverPendingAssistantFromGateway({
      localMessages: [userMessage(10)],
      fallbackPreviousResponseId: "resp_local_anchor_1",
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      completionFetchMaxAttempts: 1,
      completionFetchDelayMs: 0,
      missingMessageRetryAfterMs: 30_000,
      querySessionMessages: async () => [],
      querySessionState: async () =>
        stateRow({
          inProgress: false,
          lastResponseId: "resp_server_anchor_1",
          updatedAt: 10,
        }),
      queryTurnState: async () => null,
      persistCompletedTurn: async () => null,
      now: () => 50_000,
    })

    expect(result).toEqual({
      recovered: false,
      retrySend: true,
      previewContent: undefined,
    })
  })

  it("keeps syncing when anchor advanced but missing message is not stale yet", async () => {
    const result = await recoverPendingAssistantFromGateway({
      localMessages: [userMessage(10)],
      fallbackPreviousResponseId: "resp_local_anchor_1",
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      completionFetchMaxAttempts: 1,
      completionFetchDelayMs: 0,
      missingMessageRetryAfterMs: 30_000,
      querySessionMessages: async () => [],
      querySessionState: async () =>
        stateRow({
          inProgress: false,
          lastResponseId: "resp_server_anchor_1",
          updatedAt: 15,
        }),
      queryTurnState: async () => null,
      persistCompletedTurn: async () => null,
      now: () => 20,
    })

    expect(result).toEqual({
      recovered: false,
      inProgress: true,
      previewContent: undefined,
    })
  })

  it("recovers after completion when messages become visible with delay", async () => {
    let messageCall = 0
    let waits = 0
    const result = await recoverPendingAssistantFromGateway({
      localMessages: [userMessage(1)],
      fallbackPreviousResponseId: "resp_prev_1",
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      completionFetchMaxAttempts: 3,
      completionFetchDelayMs: 5,
      missingMessageRetryAfterMs: 30_000,
      querySessionMessages: async () => {
        messageCall += 1
        if (messageCall < 3) {
          return []
        }
        return [assistantRow({ responseId: "resp_1", content: "done later", createdAt: 3 })]
      },
      querySessionState: async () => stateRow({ inProgress: false }),
      queryTurnState: async () => null,
      persistCompletedTurn: async () => completedTurnResult,
      wait: async () => {
        waits += 1
      },
    })

    expect(result.recovered).toBe(true)
    expect(result.previewContent).toBe("done later")
    expect(waits).toBe(1)
  })
})
