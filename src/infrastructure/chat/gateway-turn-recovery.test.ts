import { describe, expect, it } from "bun:test"
import type { ChatTurnResult } from "../../domain/chat/types"
import type { GatewaySessionState, GatewayTurnState } from "./gateway-session-recovery"
import { attemptGatewayTurnRecovery } from "./gateway-turn-recovery"

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

describe("attemptGatewayTurnRecovery", () => {
  it("returns none when session or turn id is missing", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: false,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () => {
        throw new Error("should not query")
      },
      querySessionState: async () => null,
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({ kind: "none" })
  })

  it("returns completed when turn is already finished and persistence succeeds", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: false,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () => turnState({ status: "completed", responseId: "resp_1" }),
      querySessionState: async () => null,
      persistCompletedTurn: async (input) => {
        expect(input.sessionId).toBe("sess_1")
        expect(input.turnState.responseId).toBe("resp_1")
        return completedTurnResult
      },
    })

    expect(result).toEqual({
      kind: "completed",
      result: completedTurnResult,
    })
  })

  it("returns none when completed turn cannot be persisted", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: false,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () => turnState({ status: "completed" }),
      querySessionState: async () => null,
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({ kind: "none" })
  })

  it("polls in-progress turn until it completes", async () => {
    const turnStates = [turnState({ status: "in_progress" }), turnState({ status: "completed" })]
    let waits = 0
    let calls = 0

    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: false,
      turnRecoveryPollInProgressMaxAttempts: 2,
      turnRecoveryPollInProgressDelayMs: 5,
      queryTurnState: async () => {
        const next = turnStates[Math.min(calls, turnStates.length - 1)]
        calls += 1
        return next
      },
      querySessionState: async () => null,
      persistCompletedTurn: async () => completedTurnResult,
      wait: async () => {
        waits += 1
      },
    })

    expect(result).toEqual({
      kind: "completed",
      result: completedTurnResult,
    })
    expect(waits).toBe(1)
    expect(calls).toBe(2)
  })

  it("requests retry_send when turn is not found and retry is allowed", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: true,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () => turnState({ status: "not_found", responseId: "" }),
      querySessionState: async () => null,
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({ kind: "retry_send" })
  })

  it("returns in_progress when the same turn is still active after polling", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: false,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () => turnState({ status: "in_progress" }),
      querySessionState: async () =>
        sessionState({
          inProgress: true,
          activeClientTurnId: "turn_1",
        }),
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({ kind: "in_progress" })
  })

  it("returns none when another turn is active", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: false,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () => turnState({ status: "in_progress" }),
      querySessionState: async () =>
        sessionState({
          inProgress: true,
          activeClientTurnId: "turn_2",
        }),
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({ kind: "none" })
  })

  it("returns none for failed turn state", async () => {
    const result = await attemptGatewayTurnRecovery({
      conversationId: "conv_1",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      fallbackPreviousResponseId: "resp_prev_1",
      allowRetryFromNotFound: true,
      turnRecoveryPollInProgressMaxAttempts: 0,
      turnRecoveryPollInProgressDelayMs: 0,
      queryTurnState: async () =>
        turnState({
          status: "failed",
          errorCode: "gateway_error",
          errorMessage: "failed",
        }),
      querySessionState: async () => null,
      persistCompletedTurn: async () => null,
    })

    expect(result).toEqual({ kind: "none" })
  })
})
