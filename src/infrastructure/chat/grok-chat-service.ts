import type { AppConfig } from "../../app/contracts"
import type { ChatService } from "../../domain/chat/service"
import type {
  ChatAnchors,
  ChatCardAttachmentPayload,
  ChatDeepSearchResearch,
  ChatMessage,
  ChatReasoningEventDetail,
  ChatTurnResult,
  ChatStreamEvent,
  ChatStreamEventMeta,
  SendChatTurnInput,
} from "../../domain/chat/types"
import type { AppRepository, ConversationRecord } from "../../domain/storage/repository"
import { createRuntimeFetch } from "../http/runtime-fetch"
import {
  type AssistantToolMetaPayload,
  buildConversationId,
  buildUserMessage,
  isRecord,
} from "./chunk-parsers"
import {
  type GatewaySessionMessage,
  type GatewaySessionRecoveryClient,
  type GatewayTurnState,
  StreamIdleTimeoutError,
  createGatewaySessionRecoveryClient,
  normalizeTurnRecoverySetting,
} from "./gateway-session-recovery"
import { type RenewedAssetUrlPayload } from "./gateway-media-assets"
import { refreshMessagesWithGeneratedMediaAssets } from "./gateway-media-workflows"
import { buildCompletedGatewayTurn } from "./gateway-turn-completion"
import { GatewayStreamAccumulator, readReasoningEventResponseId } from "./gateway-stream-accumulator"
import { resolveGatewayRegenerateTarget } from "./gateway-regenerate-target-resolver"
import { persistRecoveredCompletedTurnFromGateway } from "./gateway-recovered-turn-persistence"
import { recoverPendingAssistantFromGateway } from "./gateway-pending-assistant-recovery"
import { executeGatewayStreamTransport } from "./gateway-stream-transport"
import {
  type GatewayTurnRecoveryOutcome,
  attemptGatewayTurnRecovery,
} from "./gateway-turn-recovery"
import {
  buildGatewayTurnRequestPayload,
  buildUserMessageText,
} from "./gateway-turn-request-builder"
import { hydrateGeneratedImageCardsFromGateway } from "./gateway-generated-image-renewal"

function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) {
    return "http://localhost:8787/v1/responses"
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/responses`
  }
  return `${trimmed}/v1/responses`
}

/**
 * Normalize the API base URL to the /v1 path (for model catalog etc.)
 */
export function normalizeGatewayBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) {
    return "http://localhost:8787/v1"
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  if (trimmed.endsWith("/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  return `${trimmed}/v1`
}

function createConversationRecord(
  conversationId: string,
  title: string,
  anchors: Partial<ChatAnchors>,
  now: number
): ConversationRecord {
  return {
    id: conversationId,
    title,
    anchors,
    createdAt: now,
    updatedAt: now,
  }
}

function fallbackConversationTitleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) {
    return ""
  }
  const maxLength = 48
  if (firstLine.length <= maxLength) {
    return firstLine
  }
  return `${firstLine.slice(0, maxLength).trim()}...`
}

const STREAM_IDLE_TIMEOUT_MS_DEFAULT = 20_000
const STREAM_IDLE_TIMEOUT_MS_MAX = 120_000
const STREAM_IDLE_RETRY_MAX_ATTEMPTS_DEFAULT = 1
const STREAM_IDLE_RETRY_MAX_ATTEMPTS_MAX = 10
const STREAM_IDLE_RETRY_DELAY_MS_DEFAULT = 450
const STREAM_IDLE_RETRY_DELAY_MS_MAX = 30_000
const TURN_RECOVERY_MESSAGES_LIMIT_DEFAULT = 100
const TURN_RECOVERY_MESSAGES_LIMIT_MAX = 500
const TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_DEFAULT = 1
const TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_MAX = 10
const TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_DEFAULT = 2
const TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_MAX = 20
const TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_DEFAULT = 700
const TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_MAX = 30_000
const TURN_RECOVERY_IN_PROGRESS_RETRY_MAX_ATTEMPTS_DEFAULT = 1
const TURN_RECOVERY_IN_PROGRESS_RETRY_DELAY_MS_DEFAULT = 600
const TURN_RECOVERY_IN_PROGRESS_RETRY_MAX_ATTEMPTS_MAX = 10
const TURN_RECOVERY_IN_PROGRESS_RETRY_DELAY_MS_MAX = 30_000
const PENDING_RECOVERY_COMPLETION_FETCH_MAX_ATTEMPTS = 3
const PENDING_RECOVERY_COMPLETION_FETCH_DELAY_MS = 500
const PENDING_RECOVERY_MESSAGE_MISSING_RETRY_AFTER_MS = 30_000

export class GrokChatService implements ChatService {
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly runtimeFetch: typeof fetch
  private readonly gatewayBaseUrl: string
  private readonly streamIdleTimeoutMs: number
  private readonly streamIdleRetryMaxAttempts: number
  private readonly streamIdleRetryDelayMs: number
  private readonly turnRecoveryMessagesLimit: number
  private readonly turnRecoveryNotFoundRetryMaxAttempts: number
  private readonly turnRecoveryPollInProgressMaxAttempts: number
  private readonly turnRecoveryPollInProgressDelayMs: number
  private readonly turnInProgressRetryMaxAttempts: number
  private readonly turnInProgressRetryDelayMs: number

  constructor(
    private readonly repository: AppRepository,
    config: AppConfig
  ) {
    this.apiUrl = normalizeApiBaseUrl(config.apiBaseUrl)
    this.apiKey = config.apiKey || ""
    this.runtimeFetch = createRuntimeFetch(fetch)
    this.gatewayBaseUrl = normalizeGatewayBaseUrl(this.apiUrl)
    this.streamIdleTimeoutMs = normalizeTurnRecoverySetting(
      config.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_MS_DEFAULT,
      STREAM_IDLE_TIMEOUT_MS_MAX
    )
    this.streamIdleRetryMaxAttempts = normalizeTurnRecoverySetting(
      config.streamIdleRetryMaxAttempts,
      STREAM_IDLE_RETRY_MAX_ATTEMPTS_DEFAULT,
      STREAM_IDLE_RETRY_MAX_ATTEMPTS_MAX
    )
    this.streamIdleRetryDelayMs = normalizeTurnRecoverySetting(
      config.streamIdleRetryDelayMs,
      STREAM_IDLE_RETRY_DELAY_MS_DEFAULT,
      STREAM_IDLE_RETRY_DELAY_MS_MAX
    )
    this.turnRecoveryMessagesLimit = normalizeTurnRecoverySetting(
      config.turnRecoveryMessagesLimit,
      TURN_RECOVERY_MESSAGES_LIMIT_DEFAULT,
      TURN_RECOVERY_MESSAGES_LIMIT_MAX
    )
    this.turnRecoveryNotFoundRetryMaxAttempts = normalizeTurnRecoverySetting(
      config.turnRecoveryNotFoundRetryMaxAttempts,
      TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_DEFAULT,
      TURN_RECOVERY_NOT_FOUND_RETRY_MAX_ATTEMPTS_MAX
    )
    this.turnRecoveryPollInProgressMaxAttempts = normalizeTurnRecoverySetting(
      config.turnRecoveryPollInProgressMaxAttempts,
      TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_DEFAULT,
      TURN_RECOVERY_POLL_IN_PROGRESS_MAX_ATTEMPTS_MAX
    )
    this.turnRecoveryPollInProgressDelayMs = normalizeTurnRecoverySetting(
      config.turnRecoveryPollInProgressDelayMs,
      TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_DEFAULT,
      TURN_RECOVERY_POLL_IN_PROGRESS_DELAY_MS_MAX
    )
    this.turnInProgressRetryMaxAttempts = normalizeTurnRecoverySetting(
      config.turnInProgressRetryMaxAttempts,
      TURN_RECOVERY_IN_PROGRESS_RETRY_MAX_ATTEMPTS_DEFAULT,
      TURN_RECOVERY_IN_PROGRESS_RETRY_MAX_ATTEMPTS_MAX
    )
    this.turnInProgressRetryDelayMs = normalizeTurnRecoverySetting(
      config.turnInProgressRetryDelayMs,
      TURN_RECOVERY_IN_PROGRESS_RETRY_DELAY_MS_DEFAULT,
      TURN_RECOVERY_IN_PROGRESS_RETRY_DELAY_MS_MAX
    )
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const list = await this.repository.listMessages(conversationId)
    const hydrateGeneratedImageCards = this.createGeneratedImageCardHydrator()
    const refreshed = await refreshMessagesWithGeneratedMediaAssets({
      messages: list,
      apiUrl: this.apiUrl,
      hydrateGeneratedImageCards,
    })
    if (refreshed.updated.length > 0) {
      await Promise.all(
        refreshed.updated.map(async (message) => {
          try {
            await this.repository.updateMessage(conversationId, message)
          } catch {
            // Read path should not fail just because persistence of renewed URLs fails.
          }
        })
      )
    }
    return refreshed.messages
  }

  private async persistAssistantTurnResult(input: {
    conversationId: string
    assistantMessage: ChatMessage
    anchors: ChatAnchors
    resolvedTitle: string
    commitTime: number
    regenerateTargetResponseId?: string
  }): Promise<void> {
    const regenerateTargetResponseId = input.regenerateTargetResponseId?.trim() || ""
    if (regenerateTargetResponseId) {
      const existingMessages = await this.repository.listMessages(input.conversationId).catch(() => [])
      const targetAssistant = existingMessages.find(
        (row) =>
          row.role === "assistant" &&
          (((row.responseId || "").trim() && (row.responseId || "").trim() === regenerateTargetResponseId) ||
            row.id === regenerateTargetResponseId)
      )
      if (targetAssistant) {
        await this.repository.truncateMessagesAfter(input.conversationId, targetAssistant.id, true)
      }
    }

    await this.repository.appendMessage(input.conversationId, input.assistantMessage)
    await this.repository.upsertConversation(
      createConversationRecord(
        input.conversationId,
        input.resolvedTitle,
        input.anchors,
        input.commitTime
      )
    )
  }

  async resolveRegenerateTarget(input: {
    conversationId: string
    sessionId: string
    messageId: string
  }): Promise<{
    responseId: string
    previousResponseId: string
  }> {
    const conversationId = (input.conversationId || "").trim()
    const sessionId = (input.sessionId || "").trim()
    const messageId = (input.messageId || "").trim()
    if (!conversationId || !sessionId || !messageId) {
      return {
        responseId: "",
        previousResponseId: "",
      }
    }

    const localMessages = await this.repository.listMessages(conversationId).catch(() => [])
    const targetMessage = localMessages.find((row) => row.id === messageId && row.role === "assistant")
    if (!targetMessage || targetMessage.role !== "assistant") {
      return {
        responseId: "",
        previousResponseId: "",
      }
    }

    const sessionMessages = await this.getGatewayRecoveryClient().querySessionMessages(sessionId, "")
    const { matchedAssistant, resolvedResponseId, resolvedPreviousResponseId } =
      resolveGatewayRegenerateTarget({
        localMessages,
        sessionMessages,
        messageId,
      })

    const currentResponseId = targetMessage.responseId?.trim() || ""
    const currentPreviousResponseId = targetMessage.previousResponseId?.trim() || ""
    if (
      matchedAssistant &&
      (resolvedResponseId !== currentResponseId || resolvedPreviousResponseId !== currentPreviousResponseId)
    ) {
      await this.repository.updateMessage(conversationId, {
        ...targetMessage,
        responseId: resolvedResponseId || undefined,
        previousResponseId: resolvedPreviousResponseId || undefined,
      })
    }

    const sessionState = await this.getGatewayRecoveryClient().querySessionState(sessionId)
    if (sessionState?.lastResponseId.trim()) {
      const existingConversations = await this.repository.listConversations()
      const currentConversation = existingConversations.find((item) => item.id === conversationId)
      await this.repository.upsertConversation({
        id: conversationId,
        title: currentConversation?.title || fallbackConversationTitleFromPrompt(targetMessage.content),
        anchors: {
          sessionId,
          conversationId,
          lastResponseId: sessionState.lastResponseId.trim(),
        },
        createdAt: currentConversation?.createdAt || Date.now(),
        updatedAt: Date.now(),
      })
    }

    return {
      responseId: resolvedResponseId,
      previousResponseId: resolvedPreviousResponseId,
    }
  }

  async recoverPendingAssistant(input: {
    conversationId: string
    anchors: Partial<ChatAnchors>
  }): Promise<{
    recovered: boolean
    inProgress?: boolean
    retrySend?: boolean
    previewContent?: string
    result?: ChatTurnResult
  }> {
    const conversationId = (input.conversationId || "").trim()
    const sessionId = (input.anchors.sessionId || "").trim()
    if (!conversationId || !sessionId) {
      return { recovered: false }
    }

    const fallbackPreviousResponseId = (input.anchors.lastResponseId || "").trim()
    const localMessages = await this.repository.listMessages(conversationId).catch(() => [])
    const recoveryClient = this.getGatewayRecoveryClient()

    return recoverPendingAssistantFromGateway({
      localMessages,
      fallbackPreviousResponseId,
      turnRecoveryPollInProgressMaxAttempts: this.turnRecoveryPollInProgressMaxAttempts,
      turnRecoveryPollInProgressDelayMs: this.turnRecoveryPollInProgressDelayMs,
      completionFetchMaxAttempts: PENDING_RECOVERY_COMPLETION_FETCH_MAX_ATTEMPTS,
      completionFetchDelayMs: PENDING_RECOVERY_COMPLETION_FETCH_DELAY_MS,
      missingMessageRetryAfterMs: PENDING_RECOVERY_MESSAGE_MISSING_RETRY_AFTER_MS,
      querySessionMessages: (afterResponseId) =>
        recoveryClient.querySessionMessages(sessionId, afterResponseId),
      querySessionState: () => recoveryClient.querySessionState(sessionId),
      queryTurnState: (clientTurnId) => recoveryClient.queryTurnState(sessionId, clientTurnId),
      persistCompletedTurn: (turnState) =>
        this.persistRecoveredCompletedTurn({
          conversationId,
          sessionId,
          turnState,
          fallbackPreviousResponseId,
        }),
    })
  }

  private getGatewayRecoveryClient(): GatewaySessionRecoveryClient {
    return createGatewaySessionRecoveryClient({
      gatewayBaseUrl: this.gatewayBaseUrl,
      runtimeFetch: this.runtimeFetch,
      createAuthHeaders: (extra) => this.createGatewayAuthHeaders(extra),
      turnRecoveryMessagesLimit: this.turnRecoveryMessagesLimit,
    })
  }

  private createGatewayAuthHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(extra || {}),
    }
  }

  private createGeneratedImageCardHydrator() {
    return (
      cards: ChatCardAttachmentPayload[],
      sharedRenewCache?: Map<string, Promise<RenewedAssetUrlPayload | null>>
    ) =>
      hydrateGeneratedImageCardsFromGateway({
        cards,
        sharedRenewCache,
        gatewayBaseUrl: this.gatewayBaseUrl,
        runtimeFetch: this.runtimeFetch,
        createAuthHeaders: (extra) => this.createGatewayAuthHeaders(extra),
      })
  }

  private async persistRecoveredCompletedTurn(input: {
    conversationId: string
    sessionId: string
    turnState: GatewayTurnState
    fallbackPreviousResponseId: string
  }): Promise<ChatTurnResult | null> {
    const recoveryClient = this.getGatewayRecoveryClient()
    return persistRecoveredCompletedTurnFromGateway({
      ...input,
      listMessages: () => this.repository.listMessages(input.conversationId),
      listConversations: () => this.repository.listConversations(),
      updateMessage: (message) => this.repository.updateMessage(input.conversationId, message),
      appendMessage: (message) => this.repository.appendMessage(input.conversationId, message),
      upsertConversation: (record) => this.repository.upsertConversation(record),
      querySessionMessages: (afterResponseId) =>
        recoveryClient.querySessionMessages(input.sessionId, afterResponseId),
      querySessionState: () => recoveryClient.querySessionState(input.sessionId),
      createConversationRecord: (title, anchors, now) =>
        createConversationRecord(input.conversationId, title, anchors, now),
      fallbackConversationTitleFromPrompt,
    })
  }

  private async attemptTurnRecovery(input: {
    conversationId: string
    sessionId: string
    clientTurnId: string
    fallbackPreviousResponseId: string
    allowRetryFromNotFound: boolean
  }): Promise<GatewayTurnRecoveryOutcome> {
    const recoveryClient = this.getGatewayRecoveryClient()
    return attemptGatewayTurnRecovery({
      ...input,
      turnRecoveryPollInProgressMaxAttempts: this.turnRecoveryPollInProgressMaxAttempts,
      turnRecoveryPollInProgressDelayMs: this.turnRecoveryPollInProgressDelayMs,
      queryTurnState: (sessionId, clientTurnId) =>
        recoveryClient.queryTurnState(sessionId, clientTurnId),
      querySessionState: (sessionId) => recoveryClient.querySessionState(sessionId),
      persistCompletedTurn: (persistInput) => this.persistRecoveredCompletedTurn(persistInput),
    })
  }

  async upsertAnchors(anchors: ChatAnchors): Promise<void> {
    const now = Date.now()
    const conversationId = anchors.conversationId || anchors.sessionId || `conv_${crypto.randomUUID()}`
    const existingConversations = await this.repository.listConversations()
    const currentConversation = existingConversations.find((item) => item.id === conversationId)
    const currentTitle = currentConversation?.title || ""
    await this.repository.upsertConversation({
      id: conversationId,
      title: currentTitle,
      anchors,
      createdAt: now,
      updatedAt: now,
    })
  }

  async streamTurn(
    input: SendChatTurnInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const conversationId = buildConversationId(input.anchors)
    const anchoredSessionId = input.anchors.sessionId?.trim() || ""
    const sessionId = anchoredSessionId || `sess_${crypto.randomUUID()}`
    const clientTurnId = input.clientTurnId?.trim() || `turn_${crypto.randomUUID()}`
    const regenerateTargetResponseId = input.regenerateTargetResponseId?.trim() || ""
    const isRegenerate = regenerateTargetResponseId.length > 0
    const fallbackPreviousResponseId = input.anchors.lastResponseId?.trim() || ""
    const existingConversations = await this.repository.listConversations()
    const currentConversation = existingConversations.find((item) => item.id === conversationId)
    const currentTitle = currentConversation?.title || ""
    const fallbackTitle = fallbackConversationTitleFromPrompt(input.text)
    await this.repository.upsertConversation(
      createConversationRecord(
        conversationId,
        currentTitle || fallbackTitle,
        {
          sessionId,
          conversationId,
          lastResponseId: fallbackPreviousResponseId,
        },
        Date.now()
      )
    )
    if (!isRegenerate && !input.retryExistingUserMessage) {
      const userMessage = buildUserMessage(buildUserMessageText(input.text, input.attachments))
      await this.repository.appendMessage(conversationId, userMessage)
    }

    const requestId = `req_${crypto.randomUUID()}`
    const streamStartedAt = Date.now()
    let gatewayResponseId = ""
    let streamEventSeq = 0
    const nextStreamMeta = (responseId?: string): ChatStreamEventMeta => {
      streamEventSeq += 1
      const meta: ChatStreamEventMeta = {
        seq: streamEventSeq,
        ts: Date.now(),
        conversationId,
      }
      const normalizedResponseId = responseId?.trim() || gatewayResponseId.trim()
      if (normalizedResponseId) {
        meta.responseId = normalizedResponseId
      }
      return meta
    }
    const emitStarted = (startedRequestId: string) => {
      onEvent({
        type: "started",
        requestId: startedRequestId,
        meta: nextStreamMeta(),
      })
    }
    const emitDelta = (textDelta: string, responseId?: string) => {
      onEvent({
        type: "delta",
        textDelta,
        meta: nextStreamMeta(responseId),
      })
    }
    const emitReasoning = (detail: ChatReasoningEventDetail, responseId?: string) => {
      onEvent({
        type: "reasoning",
        detail,
        meta: nextStreamMeta(responseId),
      })
    }
    const emitHeartbeat = (idleMs: number, responseId?: string) => {
      onEvent({
        type: "heartbeat",
        idleMs,
        meta: nextStreamMeta(responseId),
      })
    }
    const emitCompleted = (result: ChatTurnResult, responseId?: string) => {
      onEvent({
        type: "completed",
        result,
        meta: nextStreamMeta(responseId),
      })
    }
    const emitFailed = (code: string, message: string, responseId?: string) => {
      onEvent({
        type: "failed",
        code,
        message,
        meta: nextStreamMeta(responseId),
      })
    }
    emitStarted(requestId)

    try {
      const requestBodyPayload = await buildGatewayTurnRequestPayload({
        model: input.model,
        sessionId,
        clientTurnId,
        text: input.text,
        attachments: input.attachments,
        anchoredSessionId,
        fallbackPreviousResponseId,
        regenerateTargetResponseId,
      })

      const accumulator = new GatewayStreamAccumulator(this.apiUrl)
      const transport = await executeGatewayStreamTransport({
        apiUrl: this.apiUrl,
        runtimeFetch: this.runtimeFetch,
        createAuthHeaders: (extra) => this.createGatewayAuthHeaders(extra),
        clientTurnId,
        requestBodyPayload,
        accumulator,
        isRegenerate,
        signal,
        streamIdleTimeoutMs: this.streamIdleTimeoutMs,
        streamIdleRetryMaxAttempts: this.streamIdleRetryMaxAttempts,
        streamIdleRetryDelayMs: this.streamIdleRetryDelayMs,
        turnRecoveryNotFoundRetryMaxAttempts: this.turnRecoveryNotFoundRetryMaxAttempts,
        turnInProgressRetryMaxAttempts: this.turnInProgressRetryMaxAttempts,
        turnInProgressRetryDelayMs: this.turnInProgressRetryDelayMs,
        emitDelta,
        emitReasoning,
        emitHeartbeat,
        attemptTurnRecovery: (allowRetryFromNotFound) =>
          this.attemptTurnRecovery({
            conversationId,
            sessionId,
            clientTurnId,
            fallbackPreviousResponseId,
            allowRetryFromNotFound,
          }),
      })
      gatewayResponseId = transport.gatewayResponseId
      if (transport.kind === "completed") {
        emitCompleted(transport.result, transport.result.assistantMessage.responseId)
        return
      }
      if (transport.kind === "failed") {
        emitFailed(transport.code, transport.message, transport.gatewayResponseId)
        return
      }

      const commitTime = Date.now()
      const hydrateGeneratedImageCards = this.createGeneratedImageCardHydrator()
      const completion = await buildCompletedGatewayTurn({
        state: accumulator.snapshotCompletionState(),
        apiUrl: this.apiUrl,
        hydrateGeneratedImageCards,
        renewCache: new Map<string, Promise<RenewedAssetUrlPayload | null>>(),
        gatewayResponseId,
        sessionId,
        conversationId,
        previousResponseId: input.anchors.lastResponseId || "",
        currentTitle,
        fallbackTitle,
        streamStartedAt,
        commitTime,
      })
      await this.persistAssistantTurnResult({
        conversationId,
        assistantMessage: completion.result.assistantMessage,
        anchors: completion.result.anchors,
        resolvedTitle: completion.resolvedTitle,
        commitTime,
        regenerateTargetResponseId: isRegenerate ? regenerateTargetResponseId : undefined,
      })

      emitCompleted(completion.result, completion.result.assistantMessage.responseId)
    } catch (error) {
      if (!isRegenerate) {
        const recovery = await this.attemptTurnRecovery({
          conversationId,
          sessionId,
          clientTurnId,
          fallbackPreviousResponseId,
          allowRetryFromNotFound: false,
        })
        if (recovery.kind === "completed") {
          emitCompleted(recovery.result, recovery.result.assistantMessage.responseId)
          return
        }
        if (recovery.kind === "in_progress") {
          emitFailed("turn_in_progress", "turn_is_still_in_progress", gatewayResponseId)
          return
        }
      }
      if (error instanceof StreamIdleTimeoutError) {
        emitFailed("stream_idle_timeout", error.message, gatewayResponseId)
        return
      }
      const message = error instanceof Error ? error.message : "unknown_error"
      emitFailed("chat_stream_error", message)
    }
  }
}
