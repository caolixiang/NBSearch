import type { ChatTurnResult } from "../../domain/chat/types"
import {
  type GatewaySessionState,
  type GatewayTurnState,
  waitForRetryDelay,
} from "./gateway-session-recovery"

export type GatewayTurnRecoveryOutcome =
  | {
      kind: "retry_send"
    }
  | {
      kind: "in_progress"
    }
  | {
      kind: "completed"
      result: ChatTurnResult
    }
  | {
      kind: "none"
    }

type AttemptGatewayTurnRecoveryInput = {
  conversationId: string
  sessionId: string
  clientTurnId: string
  fallbackPreviousResponseId: string
  allowRetryFromNotFound: boolean
  turnRecoveryPollInProgressMaxAttempts: number
  turnRecoveryPollInProgressDelayMs: number
  queryTurnState: (sessionId: string, clientTurnId: string) => Promise<GatewayTurnState | null>
  querySessionState: (sessionId: string) => Promise<GatewaySessionState | null>
  persistCompletedTurn: (input: {
    conversationId: string
    sessionId: string
    turnState: GatewayTurnState
    fallbackPreviousResponseId: string
  }) => Promise<ChatTurnResult | null>
  wait?: (delayMs: number) => Promise<void>
}

export async function attemptGatewayTurnRecovery(
  input: AttemptGatewayTurnRecoveryInput
): Promise<GatewayTurnRecoveryOutcome> {
  const normalizedSessionId = input.sessionId.trim()
  const normalizedClientTurnId = input.clientTurnId.trim()
  if (!normalizedSessionId || !normalizedClientTurnId) {
    return { kind: "none" }
  }

  let turnState = await input.queryTurnState(normalizedSessionId, normalizedClientTurnId)
  if (!turnState) {
    return { kind: "none" }
  }

  const wait = input.wait || ((delayMs: number) => waitForRetryDelay(delayMs))
  if (turnState.status === "in_progress") {
    for (let attempt = 0; attempt < input.turnRecoveryPollInProgressMaxAttempts; attempt += 1) {
      await wait(input.turnRecoveryPollInProgressDelayMs)
      const next = await input.queryTurnState(normalizedSessionId, normalizedClientTurnId)
      if (!next) {
        break
      }
      turnState = next
      if (turnState.status !== "in_progress") {
        break
      }
    }
  }

  if (turnState.status === "completed") {
    const recovered = await input.persistCompletedTurn({
      conversationId: input.conversationId,
      sessionId: normalizedSessionId,
      turnState,
      fallbackPreviousResponseId: input.fallbackPreviousResponseId,
    })
    if (recovered) {
      return {
        kind: "completed",
        result: recovered,
      }
    }
    return { kind: "none" }
  }

  if (turnState.status === "not_found" && input.allowRetryFromNotFound) {
    return { kind: "retry_send" }
  }

  if (turnState.status === "in_progress") {
    const sessionState = await input.querySessionState(normalizedSessionId)
    const activeClientTurnId = sessionState?.activeClientTurnId.trim() || ""
    const sameTurnActive = !activeClientTurnId || activeClientTurnId === normalizedClientTurnId
    if (sessionState?.inProgress && sameTurnActive) {
      return { kind: "in_progress" }
    }
  }

  return { kind: "none" }
}
