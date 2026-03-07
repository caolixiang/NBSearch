import type {
  ChatCardAttachmentPayload,
  ChatMessage,
  ChatTurnResult,
} from "../../domain/chat/types"
import type { AppRepository } from "../../domain/storage/repository"
import type { RenewedAssetUrlPayload } from "./gateway-media-assets"
import {
  type GatewaySessionRecoveryClient,
  type GatewayTurnState,
  createGatewaySessionRecoveryClient,
} from "./gateway-session-recovery"
import { hydrateGeneratedImageCardsFromGateway } from "./gateway-generated-image-renewal"
import { recoverPendingAssistantFromGateway } from "./gateway-pending-assistant-recovery"
import { persistRecoveredCompletedTurnFromGateway } from "./gateway-recovered-turn-persistence"
import {
  type GatewayTurnRecoveryOutcome,
  attemptGatewayTurnRecovery,
} from "./gateway-turn-recovery"
import {
  createConversationRecord,
  fallbackConversationTitleFromPrompt,
} from "./gateway-conversation-persistence"

export type GatewayRecoveryRuntime = ReturnType<typeof createGatewayRecoveryRuntime>

export function createGatewayRecoveryRuntime(input: {
  repository: Pick<
    AppRepository,
    | "listMessages"
    | "listConversations"
    | "updateMessage"
    | "appendMessage"
    | "upsertConversation"
  >
  getGatewayBaseUrl: () => string
  getRuntimeFetch: () => typeof fetch
  getApiKey: () => string
  turnRecoveryMessagesLimit: number
  turnRecoveryPollInProgressMaxAttempts: number
  turnRecoveryPollInProgressDelayMs: number
  completionFetchMaxAttempts: number
  completionFetchDelayMs: number
  missingMessageRetryAfterMs: number
}) {
  const createAuthHeaders = (extra?: Record<string, string>): Record<string, string> => ({
    ...(input.getApiKey() ? { Authorization: `Bearer ${input.getApiKey()}` } : {}),
    ...(extra || {}),
  })

  const createRecoveryClient = (): GatewaySessionRecoveryClient =>
    createGatewaySessionRecoveryClient({
      gatewayBaseUrl: input.getGatewayBaseUrl(),
      runtimeFetch: input.getRuntimeFetch(),
      createAuthHeaders,
      turnRecoveryMessagesLimit: input.turnRecoveryMessagesLimit,
    })

  const createGeneratedImageCardHydrator = () => {
    return (
      cards: ChatCardAttachmentPayload[],
      sharedRenewCache?: Map<string, Promise<RenewedAssetUrlPayload | null>>
    ) =>
      hydrateGeneratedImageCardsFromGateway({
        cards,
        sharedRenewCache,
        gatewayBaseUrl: input.getGatewayBaseUrl(),
        runtimeFetch: input.getRuntimeFetch(),
        createAuthHeaders,
      })
  }

  const persistRecoveredCompletedTurn = async (persistInput: {
    conversationId: string
    sessionId: string
    turnState: GatewayTurnState
    fallbackPreviousResponseId: string
  }): Promise<ChatTurnResult | null> => {
    const recoveryClient = createRecoveryClient()
    return persistRecoveredCompletedTurnFromGateway({
      ...persistInput,
      listMessages: () => input.repository.listMessages(persistInput.conversationId),
      listConversations: () => input.repository.listConversations(),
      updateMessage: (message) => input.repository.updateMessage(persistInput.conversationId, message),
      appendMessage: (message) => input.repository.appendMessage(persistInput.conversationId, message),
      upsertConversation: (record) => input.repository.upsertConversation(record),
      querySessionMessages: (afterResponseId) =>
        recoveryClient.querySessionMessages(persistInput.sessionId, afterResponseId),
      querySessionState: () => recoveryClient.querySessionState(persistInput.sessionId),
      createConversationRecord: (title, anchors, now) =>
        createConversationRecord(persistInput.conversationId, title, anchors, now),
      fallbackConversationTitleFromPrompt,
    })
  }

  const recoverPendingAssistant = async (recoverInput: {
    conversationId: string
    sessionId: string
    fallbackPreviousResponseId: string
  }): Promise<{
    recovered: boolean
    inProgress?: boolean
    retrySend?: boolean
    previewContent?: string
    result?: ChatTurnResult
  }> => {
    const localMessages = await input.repository.listMessages(recoverInput.conversationId).catch(() => [])
    const recoveryClient = createRecoveryClient()

    return recoverPendingAssistantFromGateway({
      localMessages,
      fallbackPreviousResponseId: recoverInput.fallbackPreviousResponseId,
      turnRecoveryPollInProgressMaxAttempts: input.turnRecoveryPollInProgressMaxAttempts,
      turnRecoveryPollInProgressDelayMs: input.turnRecoveryPollInProgressDelayMs,
      completionFetchMaxAttempts: input.completionFetchMaxAttempts,
      completionFetchDelayMs: input.completionFetchDelayMs,
      missingMessageRetryAfterMs: input.missingMessageRetryAfterMs,
      querySessionMessages: (afterResponseId) =>
        recoveryClient.querySessionMessages(recoverInput.sessionId, afterResponseId),
      querySessionState: () => recoveryClient.querySessionState(recoverInput.sessionId),
      queryTurnState: (clientTurnId) => recoveryClient.queryTurnState(recoverInput.sessionId, clientTurnId),
      persistCompletedTurn: (turnState) =>
        persistRecoveredCompletedTurn({
          conversationId: recoverInput.conversationId,
          sessionId: recoverInput.sessionId,
          turnState,
          fallbackPreviousResponseId: recoverInput.fallbackPreviousResponseId,
        }),
    })
  }

  const attemptTurnRecovery = async (recoverInput: {
    conversationId: string
    sessionId: string
    clientTurnId: string
    fallbackPreviousResponseId: string
    allowRetryFromNotFound: boolean
  }): Promise<GatewayTurnRecoveryOutcome> => {
    const recoveryClient = createRecoveryClient()
    return attemptGatewayTurnRecovery({
      ...recoverInput,
      turnRecoveryPollInProgressMaxAttempts: input.turnRecoveryPollInProgressMaxAttempts,
      turnRecoveryPollInProgressDelayMs: input.turnRecoveryPollInProgressDelayMs,
      queryTurnState: (sessionId, clientTurnId) =>
        recoveryClient.queryTurnState(sessionId, clientTurnId),
      querySessionState: (sessionId) => recoveryClient.querySessionState(sessionId),
      persistCompletedTurn: (persistInput) => persistRecoveredCompletedTurn(persistInput),
    })
  }

  return {
    createAuthHeaders,
    createGeneratedImageCardHydrator,
    createRecoveryClient,
    recoverPendingAssistant,
    attemptTurnRecovery,
  }
}
