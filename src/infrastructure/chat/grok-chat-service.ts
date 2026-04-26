import type { AppConfig } from "../../app/contracts"
import { normalizeAppTimezone } from "../../app/personalization"
import type { ChatService, ChatSessionAvailability } from "../../domain/chat/service"
import type {
  ChatAnchors,
  ChatDeepSearchResearch,
  ChatMessage,
  ChatTurnResult,
  ChatStreamEvent,
  SendChatTurnInput,
} from "../../domain/chat/types"
import type { AppRepository } from "../../domain/storage/repository"
import { createRuntimeFetch } from "../http/runtime-fetch"
import { StreamIdleTimeoutError, normalizeTurnRecoverySetting } from "./gateway-session-recovery"
import { type RenewedAssetUrlPayload } from "./gateway-media-assets"
import { refreshMessagesWithGeneratedMediaAssets } from "./gateway-media-workflows"
import { normalizeGatewayBaseUrl, normalizeGatewayResponsesUrl } from "./gateway-url"
import { buildCompletedGatewayTurn } from "./gateway-turn-completion"
import { GatewayStreamAccumulator } from "./gateway-stream-accumulator"
import { executeGatewayStreamTransport } from "./gateway-stream-transport"
import { buildGatewayTurnRequestPayload } from "./gateway-turn-request-builder"
import { createGatewayStreamEventEmitter } from "./gateway-stream-event-emitter"
import { bootstrapGatewayTurn } from "./gateway-turn-bootstrap"
import { resolvePostCompletionConversationTitle } from "./gateway-title-generation"
import {
  createConversationRecord,
  fallbackConversationTitleFromPrompt,
  persistGatewayAssistantTurn,
  upsertGatewayConversationAnchors,
} from "./gateway-conversation-persistence"
import { syncGatewayRegenerateTarget } from "./gateway-regenerate-target-sync"
import {
  createGatewayRecoveryRuntime,
  type GatewayRecoveryRuntime,
} from "./gateway-recovery-runtime"

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
  private readonly recoveryRuntime: GatewayRecoveryRuntime
  private readonly userTimezone: string

  constructor(
    private readonly repository: AppRepository,
    private readonly config: AppConfig
  ) {
    this.apiUrl = normalizeGatewayResponsesUrl(config.apiBaseUrl)
    this.apiKey = config.apiKey || ""
    this.runtimeFetch = createRuntimeFetch(fetch)
    this.gatewayBaseUrl = normalizeGatewayBaseUrl(this.apiUrl)
    this.userTimezone = normalizeAppTimezone(config.timezone)
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
    this.recoveryRuntime = createGatewayRecoveryRuntime({
      repository: this.repository,
      getGatewayBaseUrl: () => this.gatewayBaseUrl,
      getRuntimeFetch: () => this.runtimeFetch,
      getApiKey: () => this.apiKey,
      turnRecoveryMessagesLimit: this.turnRecoveryMessagesLimit,
      turnRecoveryPollInProgressMaxAttempts: this.turnRecoveryPollInProgressMaxAttempts,
      turnRecoveryPollInProgressDelayMs: this.turnRecoveryPollInProgressDelayMs,
      completionFetchMaxAttempts: PENDING_RECOVERY_COMPLETION_FETCH_MAX_ATTEMPTS,
      completionFetchDelayMs: PENDING_RECOVERY_COMPLETION_FETCH_DELAY_MS,
      missingMessageRetryAfterMs: PENDING_RECOVERY_MESSAGE_MISSING_RETRY_AFTER_MS,
    })
  }

  private async resolveCompletionTitle(input: {
    resolvedTitle: string
    model: string
    prompt: string
  }): Promise<string> {
    const currentTitle = input.resolvedTitle.trim()
    if (currentTitle) {
      return currentTitle
    }
    return resolvePostCompletionConversationTitle({
      model: input.model,
      prompt: input.prompt,
      config: this.config,
      fetchFn: this.runtimeFetch,
    })
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const list = await this.repository.listMessages(conversationId)
    const hydrateGeneratedImageCards = this.recoveryRuntime.createGeneratedImageCardHydrator()
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
    return persistGatewayAssistantTurn({
      ...input,
      listConversations: () => this.repository.listConversations(),
      listMessages: (conversationId) => this.repository.listMessages(conversationId),
      truncateMessagesAfter: (conversationId, messageId, includeMessage) =>
        this.repository.truncateMessagesAfter(conversationId, messageId, includeMessage),
      appendMessage: (conversationId, message) => this.repository.appendMessage(conversationId, message),
      upsertConversation: (record) => this.repository.upsertConversation(record),
    })
  }

  async resolveRegenerateTarget(input: {
    conversationId: string
    sessionId: string
    messageId: string
  }): Promise<{
    responseId: string
    previousResponseId: string
  }> {
    const sessionId = (input.sessionId || "").trim()
    const recoveryClient = this.recoveryRuntime.createRecoveryClient()
    return syncGatewayRegenerateTarget({
      ...input,
      sessionId,
      listMessages: (conversationId) => this.repository.listMessages(conversationId),
      updateMessage: (conversationId, message) => this.repository.updateMessage(conversationId, message),
      listConversations: () => this.repository.listConversations(),
      upsertConversation: (record) => this.repository.upsertConversation(record),
      querySessionMessages: (afterResponseId) => recoveryClient.querySessionMessages(sessionId, afterResponseId),
      querySessionState: () => recoveryClient.querySessionState(sessionId),
    })
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

    return this.recoveryRuntime.recoverPendingAssistant({
      conversationId,
      sessionId,
      fallbackPreviousResponseId: (input.anchors.lastResponseId || "").trim(),
    })
  }

  async inspectSessionAvailability(sessionId: string): Promise<ChatSessionAvailability> {
    const normalizedSessionId = (sessionId || "").trim()
    if (!normalizedSessionId) {
      return "missing"
    }
    const url = `${this.gatewayBaseUrl}/sessions/${encodeURIComponent(normalizedSessionId)}/state`
    try {
      const response = await this.runtimeFetch(url, {
        method: "GET",
        headers: this.recoveryRuntime.createAuthHeaders(),
      })
      if (response.status === 404) {
        return "missing"
      }
      if (!response.ok) {
        return "unknown"
      }
      return "available"
    } catch {
      return "unknown"
    }
  }

  async upsertAnchors(anchors: ChatAnchors): Promise<void> {
    await upsertGatewayConversationAnchors({
      anchors,
      listConversations: () => this.repository.listConversations(),
      upsertConversation: (record) => this.repository.upsertConversation(record),
    })
  }

  async streamTurn(
    input: SendChatTurnInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const {
      conversationId,
      anchoredSessionId,
      sessionId,
      clientTurnId,
      regenerateTargetResponseId,
      isRegenerate,
      fallbackPreviousResponseId,
      currentTitle,
      fallbackTitle,
    } = await bootstrapGatewayTurn({
      turnInput: input,
      listConversations: () => this.repository.listConversations(),
      upsertConversation: (record) => this.repository.upsertConversation(record),
      appendMessage: (conversationId, message) => this.repository.appendMessage(conversationId, message),
      createConversationRecord,
      fallbackConversationTitleFromPrompt,
    })

    const requestId = `req_${crypto.randomUUID()}`
    const streamStartedAt = Date.now()
    const streamEventEmitter = createGatewayStreamEventEmitter({
      conversationId,
      onEvent,
    })
    const {
      emitStarted,
      emitDelta,
      emitReasoning,
      emitHeartbeat,
      emitCompleted,
      emitFailed,
      setGatewayResponseId,
    } = streamEventEmitter
    let gatewayResponseId = streamEventEmitter.state.gatewayResponseId
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
        timezone: this.userTimezone,
      })

      const accumulator = new GatewayStreamAccumulator(this.apiUrl)
      const transport = await executeGatewayStreamTransport({
        apiUrl: this.apiUrl,
        runtimeFetch: this.runtimeFetch,
        createAuthHeaders: (extra) => this.recoveryRuntime.createAuthHeaders(extra),
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
          this.recoveryRuntime.attemptTurnRecovery({
            conversationId,
            sessionId,
            clientTurnId,
            fallbackPreviousResponseId,
            allowRetryFromNotFound,
          }),
      })
      gatewayResponseId = transport.gatewayResponseId
      setGatewayResponseId(gatewayResponseId)
      if (transport.kind === "completed") {
        emitCompleted(transport.result, transport.result.assistantMessage.responseId)
        return
      }
      if (transport.kind === "failed") {
        emitFailed(transport.code, transport.message, transport.gatewayResponseId)
        return
      }

      const commitTime = Date.now()
      const hydrateGeneratedImageCards = this.recoveryRuntime.createGeneratedImageCardHydrator()
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
      const resolvedTitle = await this.resolveCompletionTitle({
        resolvedTitle: completion.resolvedTitle,
        model: input.model,
        prompt: input.text,
      })
      await this.persistAssistantTurnResult({
        conversationId,
        assistantMessage: completion.result.assistantMessage,
        anchors: completion.result.anchors,
        resolvedTitle,
        commitTime,
        regenerateTargetResponseId: isRegenerate ? regenerateTargetResponseId : undefined,
      })

      emitCompleted(completion.result, completion.result.assistantMessage.responseId)
    } catch (error) {
      if (!isRegenerate) {
        const recovery = await this.recoveryRuntime.attemptTurnRecovery({
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
