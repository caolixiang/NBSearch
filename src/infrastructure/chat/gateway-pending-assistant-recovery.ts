import type { ChatMessage, ChatTurnResult } from "../../domain/chat/types"
import {
  type GatewaySessionMessage,
  type GatewaySessionState,
  type GatewayTurnState,
  waitForRetryDelay,
} from "./gateway-session-recovery"

export type PendingAssistantRecoveryResult = {
  recovered: boolean
  inProgress?: boolean
  retrySend?: boolean
  previewContent?: string
  result?: ChatTurnResult
}

type RecoverPendingAssistantFromGatewayInput = {
  localMessages: ChatMessage[]
  fallbackPreviousResponseId: string
  turnRecoveryPollInProgressMaxAttempts: number
  turnRecoveryPollInProgressDelayMs: number
  completionFetchMaxAttempts: number
  completionFetchDelayMs: number
  missingMessageRetryAfterMs: number
  querySessionMessages: (afterResponseId: string) => Promise<GatewaySessionMessage[]>
  querySessionState: () => Promise<GatewaySessionState | null>
  queryTurnState: (clientTurnId: string) => Promise<GatewayTurnState | null>
  persistCompletedTurn: (turnState: GatewayTurnState) => Promise<ChatTurnResult | null>
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

type PendingAssistantTurnRecovery = {
  recovered: boolean
  inProgress: boolean
  terminal: boolean
  result?: ChatTurnResult
}

export async function recoverPendingAssistantFromGateway(
  input: RecoverPendingAssistantFromGatewayInput
): Promise<PendingAssistantRecoveryResult> {
  const wait = input.wait || ((ms: number) => waitForRetryDelay(ms))
  const now = input.now || (() => Date.now())

  let latestLocalAssistantCreatedAt = 0
  for (const message of input.localMessages) {
    if (message.role !== "assistant") {
      continue
    }
    if (message.createdAt > latestLocalAssistantCreatedAt) {
      latestLocalAssistantCreatedAt = message.createdAt
    }
  }

  let pendingUserCreatedAt = 0
  for (let index = input.localMessages.length - 1; index >= 0; index -= 1) {
    const message = input.localMessages[index]
    if (!message) {
      continue
    }
    if (message.role === "assistant") {
      break
    }
    if (message.role === "user") {
      pendingUserCreatedAt = message.createdAt
      break
    }
  }

  const minRecoverAssistantCreatedAt =
    pendingUserCreatedAt > 0
      ? pendingUserCreatedAt
      : latestLocalAssistantCreatedAt > 0
        ? latestLocalAssistantCreatedAt + 1
        : 0

  const isSessionAnchorAheadOfLocal = (state: GatewaySessionState | null): boolean => {
    const sessionLastResponseId = state?.lastResponseId.trim() || ""
    if (!sessionLastResponseId) {
      return false
    }
    if (!input.fallbackPreviousResponseId) {
      return true
    }
    return sessionLastResponseId !== input.fallbackPreviousResponseId
  }

  const shouldAutoRetrySendForMissingMessage = (state: GatewaySessionState | null): boolean => {
    if (!isSessionAnchorAheadOfLocal(state)) {
      return false
    }
    if (!state || state.inProgress) {
      return false
    }
    const referenceUpdatedAt = state.updatedAt > 0 ? state.updatedAt : 0
    const referenceTimestamp = Math.max(pendingUserCreatedAt, referenceUpdatedAt)
    if (referenceTimestamp <= 0) {
      return false
    }
    return now() - referenceTimestamp >= input.missingMessageRetryAfterMs
  }

  const pickLatestAssistantRow = (rows: GatewaySessionMessage[]): GatewaySessionMessage | null => {
    const assistantRows = rows.filter((row) => row.role === "assistant")
    if (assistantRows.length === 0) {
      return null
    }
    if (minRecoverAssistantCreatedAt > 0) {
      const recentRows = assistantRows
        .filter((row) => row.createdAt >= minRecoverAssistantCreatedAt)
        .sort((a, b) => a.createdAt - b.createdAt)
      if (recentRows.length > 0) {
        return recentRows.at(-1) || null
      }
      return null
    }
    return assistantRows.sort((a, b) => a.createdAt - b.createdAt).at(-1) || null
  }

  const tryRecoverFromMessages = async (): Promise<{
    result: ChatTurnResult | null
    previewContent: string
    assistantStatus: GatewaySessionMessage["status"] | null
  }> => {
    const recoveredRows = await input.querySessionMessages(input.fallbackPreviousResponseId)
    const candidate = pickLatestAssistantRow(recoveredRows)
    if (!candidate) {
      return {
        result: null,
        previewContent: "",
        assistantStatus: null,
      }
    }
    const previewContent = candidate.content.trim()
    if (candidate.status !== "completed") {
      return {
        result: null,
        previewContent,
        assistantStatus: candidate.status,
      }
    }

    const turnState: GatewayTurnState = {
      status: "completed",
      responseId: candidate.responseId || candidate.id,
      errorCode: "",
      errorMessage: "",
      updatedAt: candidate.createdAt || now(),
    }
    const result = await input.persistCompletedTurn(turnState)
    return {
      result,
      previewContent,
      assistantStatus: candidate.status,
    }
  }

  const tryRecoverFromTurnState = async (
    turnState: GatewayTurnState
  ): Promise<PendingAssistantTurnRecovery> => {
    if (turnState.status === "completed") {
      const recovered = await input.persistCompletedTurn(turnState)
      if (recovered) {
        return {
          recovered: true,
          inProgress: false,
          terminal: true,
          result: recovered,
        }
      }
      return {
        recovered: false,
        inProgress: false,
        terminal: false,
      }
    }
    if (turnState.status === "in_progress") {
      return {
        recovered: false,
        inProgress: true,
        terminal: false,
      }
    }
    if (turnState.status === "failed" || turnState.status === "not_found") {
      return {
        recovered: false,
        inProgress: false,
        terminal: true,
      }
    }
    return {
      recovered: false,
      inProgress: false,
      terminal: false,
    }
  }

  const recoverAfterCompletion = async (
    initialPreviewContent: string
  ): Promise<{
    recovered: boolean
    previewContent: string
    result?: ChatTurnResult
  }> => {
    let latestPreview = initialPreviewContent
    for (let attempt = 0; attempt < input.completionFetchMaxAttempts; attempt += 1) {
      const recovered = await tryRecoverFromMessages()
      latestPreview = recovered.previewContent || latestPreview
      if (recovered.result) {
        return {
          recovered: true,
          previewContent: latestPreview,
          result: recovered.result,
        }
      }
      if (attempt < input.completionFetchMaxAttempts - 1) {
        await wait(input.completionFetchDelayMs)
      }
    }
    return {
      recovered: false,
      previewContent: latestPreview,
    }
  }

  let latestPreviewContent = ""
  const recoveredImmediately = await tryRecoverFromMessages()
  latestPreviewContent = recoveredImmediately.previewContent
  if (recoveredImmediately.result) {
    return {
      recovered: true,
      previewContent: recoveredImmediately.previewContent || undefined,
      result: recoveredImmediately.result,
    }
  }

  let sessionState = await input.querySessionState()
  if (!sessionState?.inProgress) {
    const completionFetch = await recoverAfterCompletion(latestPreviewContent)
    if (completionFetch.recovered && completionFetch.result) {
      return {
        recovered: true,
        previewContent: completionFetch.previewContent || undefined,
        result: completionFetch.result,
      }
    }
    if (isSessionAnchorAheadOfLocal(sessionState)) {
      if (shouldAutoRetrySendForMissingMessage(sessionState)) {
        return {
          recovered: false,
          retrySend: true,
          previewContent: completionFetch.previewContent || undefined,
        }
      }
      return {
        recovered: false,
        inProgress: true,
        previewContent: completionFetch.previewContent || undefined,
      }
    }
    return {
      recovered: false,
      previewContent: completionFetch.previewContent || undefined,
    }
  }

  let activeClientTurnId = sessionState.activeClientTurnId.trim()
  if (activeClientTurnId) {
    const activeTurnState = await input.queryTurnState(activeClientTurnId)
    if (activeTurnState) {
      const turnRecovery = await tryRecoverFromTurnState(activeTurnState)
      if (turnRecovery.recovered && turnRecovery.result) {
        return {
          recovered: true,
          previewContent: latestPreviewContent || undefined,
          result: turnRecovery.result,
        }
      }
      if (turnRecovery.terminal && !turnRecovery.inProgress) {
        const completionFetch = await recoverAfterCompletion(latestPreviewContent)
        if (completionFetch.recovered && completionFetch.result) {
          return {
            recovered: true,
            previewContent: completionFetch.previewContent || undefined,
            result: completionFetch.result,
          }
        }
        return {
          recovered: false,
          previewContent: completionFetch.previewContent || undefined,
        }
      }
    }
  }

  for (let attempt = 0; attempt < input.turnRecoveryPollInProgressMaxAttempts; attempt += 1) {
    await wait(input.turnRecoveryPollInProgressDelayMs)
    const recovered = await tryRecoverFromMessages()
    latestPreviewContent = recovered.previewContent || latestPreviewContent
    if (recovered.result) {
      return {
        recovered: true,
        previewContent: latestPreviewContent || undefined,
        result: recovered.result,
      }
    }

    sessionState = await input.querySessionState()
    if (!sessionState?.inProgress) {
      const completionFetch = await recoverAfterCompletion(latestPreviewContent)
      if (completionFetch.recovered && completionFetch.result) {
        return {
          recovered: true,
          previewContent: completionFetch.previewContent || undefined,
          result: completionFetch.result,
        }
      }
      if (isSessionAnchorAheadOfLocal(sessionState)) {
        if (shouldAutoRetrySendForMissingMessage(sessionState)) {
          return {
            recovered: false,
            retrySend: true,
            previewContent: completionFetch.previewContent || undefined,
          }
        }
        return {
          recovered: false,
          inProgress: true,
          previewContent: completionFetch.previewContent || undefined,
        }
      }
      return {
        recovered: false,
        previewContent: completionFetch.previewContent || undefined,
      }
    }

    activeClientTurnId = sessionState.activeClientTurnId.trim()
    if (activeClientTurnId) {
      const activeTurnState = await input.queryTurnState(activeClientTurnId)
      if (activeTurnState) {
        const turnRecovery = await tryRecoverFromTurnState(activeTurnState)
        if (turnRecovery.recovered && turnRecovery.result) {
          return {
            recovered: true,
            previewContent: latestPreviewContent || undefined,
            result: turnRecovery.result,
          }
        }
        if (turnRecovery.terminal && !turnRecovery.inProgress) {
          const completionFetch = await recoverAfterCompletion(latestPreviewContent)
          if (completionFetch.recovered && completionFetch.result) {
            return {
              recovered: true,
              previewContent: completionFetch.previewContent || undefined,
              result: completionFetch.result,
            }
          }
          return {
            recovered: false,
            previewContent: completionFetch.previewContent || undefined,
          }
        }
      }
    }
  }

  return {
    recovered: false,
    inProgress: true,
    previewContent: latestPreviewContent || undefined,
  }
}
