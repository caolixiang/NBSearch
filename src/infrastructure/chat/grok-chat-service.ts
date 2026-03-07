import type { AppConfig } from "../../app/contracts"
import type { ChatService } from "../../domain/chat/service"
import type {
  ChatAnchors,
  ChatCardAttachmentPayload,
  ChatCitationCard,
  ChatDeepSearchResearch,
  ChatInlineCitation,
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
  type WebSearchToolMeta,
  appendToolMeta,
  buildConversationId,
  buildUserMessage,
  extractCardAttachmentsFromRawChunk,
  extractChunkIsThinking,
  extractDeepSearchResearchFromRawChunk,
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractGeneratedImageModeratedFromRawChunk,
  extractInlineCitationsFromText,
  isRecord,
  extractReasoningEventsFromRawChunk,
  extractResponseNewTitleFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
  parseJsonObjectStrings,
  resolveConversationTitle,
} from "./chunk-parsers"
import {
  type GatewaySessionMessage,
  type GatewaySessionRecoveryClient,
  type GatewaySessionState,
  type GatewayTurnState,
  StreamIdleTimeoutError,
  createGatewaySessionRecoveryClient,
  normalizeTurnRecoverySetting,
  waitForRetryDelay,
} from "./gateway-session-recovery"
import {
  type RenewedAssetUrlPayload,
  canonicalizeGeneratedImagePath,
  extractGeneratedImageMarkdown,
  inferGeneratedImageAssetId,
  isGeneratedImageNarration,
  isLocalRenewableImageAssetId,
  normalizeCardAttachmentUrls,
  parseRenewedAssetUrlResponse,
  preferGeneratedCardByUrlQuality,
  readCardAssetMeta,
  resolveRenewAssetIdForCard,
  shouldRenewCardAssetUrl,
  withCardAssetMeta,
  withCardAssetMetadata,
} from "./gateway-media-assets"
import {
  finalizeGeneratedMediaArtifacts,
  refreshMessagesWithGeneratedMediaAssets,
} from "./gateway-media-workflows"

const GENERATED_IMAGE_MODERATED_NOTICE = "内容已管理。请尝试一个不同的想法。"
const ANCHOR_RECOVERY_ERROR_CODES = new Set(["session_anchor_conflict", "invalid_previous_response_id"])

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

function hasAnyThinkTag(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.includes("<think") || lower.includes("</think>")
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

function extractGatewayErrorCode(errorText: string): string {
  const raw = errorText.trim()
  if (!raw) {
    return ""
  }
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.error)) {
      return ""
    }
    const code = typeof parsed.error.code === "string" ? parsed.error.code.trim() : ""
    return code || ""
  } catch {
    return ""
  }
}

function resolveReasoningDurationFromResearch(research: ChatDeepSearchResearch | undefined): number {
  if (!research) {
    return 0
  }
  const startedAtMs = Date.parse((research.thinkingStartTime || "").trim())
  const endedAtMs = Date.parse((research.thinkingEndTime || "").trim())
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return 0
  }
  if (endedAtMs <= startedAtMs) {
    return 0
  }
  return Math.max(1, Math.round((endedAtMs - startedAtMs) / 1000))
}

function resolveReasoningDurationFromLocalWindow(
  reasoningStartedAtMs: number | null,
  reasoningEndedAtMs: number | null,
  nowMs: number
): number {
  if (!reasoningStartedAtMs || reasoningStartedAtMs <= 0) {
    return 0
  }
  const endMs =
    reasoningEndedAtMs && reasoningEndedAtMs > reasoningStartedAtMs
      ? reasoningEndedAtMs
      : nowMs
  if (endMs <= reasoningStartedAtMs) {
    return 0
  }
  return Math.max(1, Math.round((endMs - reasoningStartedAtMs) / 1000))
}

function readReasoningEventResponseId(detail: ChatReasoningEventDetail): string {
  if (detail.kind === "ui_layout") {
    return detail.responseId?.trim() || ""
  }
  if (detail.kind === "tool_usage") {
    return detail.usage.responseId?.trim() || ""
  }
  if (detail.kind === "tool_result") {
    return detail.result.responseId?.trim() || ""
  }
  return ""
}

function toCitationCardFromAttachment(card: ChatCardAttachmentPayload): ChatCitationCard | null {
  const cardType = (card.cardType || card.type || "").trim()
  if (!cardType.toLowerCase().includes("citation")) {
    return null
  }
  const cardId = (card.id || "").trim()
  if (!cardId) {
    return null
  }
  return {
    cardId,
    cardType: cardType || undefined,
    url: (card.url || card.image?.link || "").trim() || undefined,
  }
}

function mergeResearchPayload(
  previous: ChatDeepSearchResearch | undefined,
  next: Partial<ChatDeepSearchResearch> | undefined
): ChatDeepSearchResearch | undefined {
  const base = previous || {}
  const incoming = next || {}
  const merged: ChatDeepSearchResearch = {
    requestMetadata:
      incoming.requestMetadata && Object.keys(incoming.requestMetadata).length > 0
        ? incoming.requestMetadata
        : base.requestMetadata,
    uiLayout: incoming.uiLayout || base.uiLayout,
    deepsearchPreset: incoming.deepsearchPreset || base.deepsearchPreset,
    thinkingStartTime: incoming.thinkingStartTime || base.thinkingStartTime,
    thinkingEndTime: incoming.thinkingEndTime || base.thinkingEndTime,
  }

  const citationMap = new Map<string, ChatCitationCard>()
  for (const row of [...(base.citationCards || []), ...(incoming.citationCards || [])]) {
    const key = `${row.cardId}\u0000${row.url || ""}`
    if (!citationMap.has(key)) {
      citationMap.set(key, row)
    }
  }
  if (citationMap.size > 0) {
    merged.citationCards = Array.from(citationMap.values())
  }

  const inlineMap = new Map<string, ChatInlineCitation>()
  for (const row of [...(base.inlineCitations || []), ...(incoming.inlineCitations || [])]) {
    const key = `${row.cardId}\u0000${row.citationId || ""}\u0000${row.url || ""}`
    if (!inlineMap.has(key)) {
      inlineMap.set(key, row)
    }
  }
  if (inlineMap.size > 0) {
    merged.inlineCitations = Array.from(inlineMap.values())
  }

  const detailMap = new Map<string, { title: string; bullets: string[] }>()
  for (const row of [...(base.details || []), ...(incoming.details || [])]) {
    const title = row.title.trim()
    const bullets = row.bullets.map((item) => item.trim()).filter(Boolean)
    const key = `${title}\u0000${bullets.join("\u0001")}`
    if (!detailMap.has(key)) {
      detailMap.set(key, {
        title: title || "深度挖掘细节",
        bullets,
      })
    }
  }
  if (detailMap.size > 0) {
    merged.details = Array.from(detailMap.values())
  }

  const stepMap = new Map<string, NonNullable<ChatDeepSearchResearch["steps"]>[number]>()
  for (const step of [...(base.steps || []), ...(incoming.steps || [])]) {
    const tags = step.tags.map((row) => row.trim()).filter(Boolean)
    const text = step.text.map((row) => row.trim()).filter(Boolean)
    const toolUsageCardIds = (step.toolUsageCardIds || []).map((row) => row.trim()).filter(Boolean)
    const toolUsages: NonNullable<NonNullable<ChatDeepSearchResearch["steps"]>[number]["toolUsages"]> = []
    for (const usage of step.toolUsages || []) {
      const toolUsageCardId = (usage.toolUsageCardId || "").trim()
      if (!toolUsageCardId) {
        continue
      }
      toolUsages.push({
        toolUsageCardId,
        toolName: (usage.toolName || "").trim() || "tool",
        args: isRecord(usage.args) ? usage.args : {},
        webSearchResults: Array.isArray(usage.webSearchResults)
          ? usage.webSearchResults.map((row) => {
              const authorName = (row.authorName || "").trim()
              const authorHandle = (row.authorHandle || "").trim()
              const publishedAt = (row.publishedAt || "").trim()
              const postId = (row.postId || "").trim()
              return {
                ...(row.kind === "x_post" ? { kind: "x_post" as const } : {}),
                title: (row.title || "").trim() || undefined,
                url: (row.url || "").trim() || undefined,
                preview: (row.preview || "").trim() || undefined,
                favicon: (row.favicon || "").trim() || undefined,
                ...(authorName ? { authorName } : {}),
                ...(authorHandle ? { authorHandle } : {}),
                ...(publishedAt ? { publishedAt } : {}),
                ...(postId ? { postId } : {}),
              }
            })
          : undefined,
      })
    }
    const title = (step.title || "").trim()
    const key = `${tags.join("\u0001")}\u0000${title}\u0000${text.join("\u0001")}\u0000${toolUsageCardIds.join("\u0001")}\u0000${toolUsages
      .map(
        (usage) =>
          `${usage.toolUsageCardId}\u0001${usage.toolName}\u0001${JSON.stringify(usage.args)}\u0001${(usage.webSearchResults || [])
            .map((row) => `${row.url || ""}\u0002${row.title || ""}`)
            .join("\u0003")}`
      )
      .join("\u0004")}`
    if (stepMap.has(key)) {
      continue
    }
    stepMap.set(key, {
      tags,
      title: title || undefined,
      text,
      toolUsageCardIds: toolUsageCardIds.length > 0 ? toolUsageCardIds : undefined,
      toolUsages: toolUsages.length > 0 ? toolUsages : undefined,
    })
  }
  if (stepMap.size > 0) {
    merged.steps = Array.from(stepMap.values())
  }

  const hasPayload = Boolean(
    merged.requestMetadata ||
      merged.uiLayout ||
      (merged.deepsearchPreset || "").trim() ||
      (merged.thinkingStartTime || "").trim() ||
      (merged.thinkingEndTime || "").trim() ||
      (merged.steps && merged.steps.length > 0) ||
      (merged.citationCards && merged.citationCards.length > 0) ||
      (merged.inlineCitations && merged.inlineCitations.length > 0) ||
      (merged.details && merged.details.length > 0)
  )
  return hasPayload ? merged : undefined
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const ASSET_URL_RENEW_TTL_SECONDS = 7200
const ASSET_URL_RENEW_THRESHOLD_MS = 60 * 1000
const STREAM_HEARTBEAT_INTERVAL_MS = 2000
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
const TURN_RECOVERY_HTTP_RETRYABLE_CODES = new Set([
  "session_in_progress",
  "turn_in_progress",
  "network_timeout",
])

type TurnRecoveryOutcome =
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

type ResponsesInputContentBlock =
  | {
      type: "text"
      text: string
    }
  | {
      type: "image_url"
      image_url: {
        url: string
      }
    }
  | {
      type: "file"
      file: {
        file_data: string
      }
    }

function normalizeAttachmentFiles(attachments?: File[]): File[] {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return []
  }
  return attachments.filter((file) => Boolean(file))
}

function buildUserMessageText(text: string, attachments?: File[]): string {
  const content = text.trim()
  const files = normalizeAttachmentFiles(attachments)
  if (files.length === 0) {
    return content
  }
  const attachmentLines = files.map((file) => `[附件] ${file.name}`)
  if (!content) {
    return attachmentLines.join("\n")
  }
  return `${content}\n\n${attachmentLines.join("\n")}`
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return globalThis.btoa(binary)
}

async function fileToDataUri(file: File): Promise<string> {
  const mimeType = file.type?.trim() || "application/octet-stream"
  const buffer = await file.arrayBuffer()
  const base64 = arrayBufferToBase64(buffer)
  return `data:${mimeType};base64,${base64}`
}

function isImageAttachment(file: File): boolean {
  const mimeType = file.type?.trim().toLowerCase() || ""
  if (mimeType.startsWith("image/")) {
    return true
  }
  return /\.(?:png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name)
}

async function buildResponsesInputContent(
  text: string,
  attachments?: File[]
): Promise<ResponsesInputContentBlock[]> {
  const blocks: ResponsesInputContentBlock[] = []
  const content = text.trim()
  const files = normalizeAttachmentFiles(attachments)

  if (content) {
    blocks.push({
      type: "text",
      text: content,
    })
  }

  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件过大：${file.name}，当前上限约 50MB`)
    }
    const dataUri = await fileToDataUri(file)
    if (isImageAttachment(file)) {
      blocks.push({
        type: "image_url",
        image_url: {
          url: dataUri,
        },
      })
      continue
    }
    blocks.push({
      type: "file",
      file: {
        file_data: dataUri,
      },
    })
  }

  if (!content && files.length > 0) {
    blocks.unshift({
      type: "text",
      text: "请分析这个附件。",
    })
  }

  return blocks
}



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
    const refreshed = await refreshMessagesWithGeneratedMediaAssets({
      messages: list,
      apiUrl: this.apiUrl,
      hydrateGeneratedImageCards: (cards, sharedRenewCache) =>
        this.hydrateGeneratedImageCards(cards, sharedRenewCache),
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
    if (sessionMessages.length === 0) {
      return {
        responseId: targetMessage.responseId?.trim() || "",
        previousResponseId: targetMessage.previousResponseId?.trim() || "",
      }
    }

    const localRenderableMessages = localMessages.filter(
      (row) => row.role === "user" || row.role === "assistant"
    )
    const sessionRenderableMessages = sessionMessages.filter(
      (row) => row.role === "user" || row.role === "assistant"
    )

    let matchedAssistant: GatewaySessionMessage | null = null
    const targetRenderableIndex = localRenderableMessages.findIndex((row) => row.id === messageId)
    const hasMatchingRoleShape =
      targetRenderableIndex >= 0 &&
      localRenderableMessages.length === sessionRenderableMessages.length &&
      localRenderableMessages.every((row, index) => row.role === sessionRenderableMessages[index]?.role)

    if (hasMatchingRoleShape) {
      const candidate = sessionRenderableMessages[targetRenderableIndex]
      if (candidate?.role === "assistant") {
        matchedAssistant = candidate
      }
    }

    if (!matchedAssistant) {
      const localAssistants = localRenderableMessages.filter((row) => row.role === "assistant")
      const sessionAssistants = sessionRenderableMessages.filter((row) => row.role === "assistant")
      const targetAssistantIndex = localAssistants.findIndex((row) => row.id === messageId)
      if (targetAssistantIndex >= 0 && targetAssistantIndex < sessionAssistants.length) {
        matchedAssistant = sessionAssistants[targetAssistantIndex] || null
      }
    }

    if (!matchedAssistant) {
      const targetContent = targetMessage.content.trim()
      if (targetContent) {
        const exactContentMatches = sessionRenderableMessages.filter(
          (row) => row.role === "assistant" && row.content.trim() === targetContent
        )
        if (exactContentMatches.length === 1) {
          matchedAssistant = exactContentMatches[0] || null
        }
      }
    }

    const resolvedResponseId = matchedAssistant?.responseId.trim() || targetMessage.responseId?.trim() || ""
    const resolvedPreviousResponseId =
      matchedAssistant?.previousResponseId.trim() || targetMessage.previousResponseId?.trim() || ""

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
    let latestLocalAssistantCreatedAt = 0
    for (const message of localMessages) {
      if (message.role !== "assistant") {
        continue
      }
      if (message.createdAt > latestLocalAssistantCreatedAt) {
        latestLocalAssistantCreatedAt = message.createdAt
      }
    }
    let pendingUserCreatedAt = 0
    for (let index = localMessages.length - 1; index >= 0; index -= 1) {
      const message = localMessages[index]
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
      if (!fallbackPreviousResponseId) {
        return true
      }
      return sessionLastResponseId !== fallbackPreviousResponseId
    }
    const shouldAutoRetrySendForMissingMessage = (state: GatewaySessionState | null): boolean => {
      if (!isSessionAnchorAheadOfLocal(state)) {
        return false
      }
      if (!state || state.inProgress) {
        return false
      }
      const now = Date.now()
      const referenceUpdatedAt = state.updatedAt > 0 ? state.updatedAt : 0
      const referenceTimestamp = Math.max(pendingUserCreatedAt, referenceUpdatedAt)
      if (referenceTimestamp <= 0) {
        return false
      }
      return now - referenceTimestamp >= PENDING_RECOVERY_MESSAGE_MISSING_RETRY_AFTER_MS
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
      const recoveredRows = await this.getGatewayRecoveryClient().querySessionMessages(sessionId, fallbackPreviousResponseId)
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
        updatedAt: candidate.createdAt || Date.now(),
      }
      const result = await this.persistRecoveredCompletedTurn({
        conversationId,
        sessionId,
        turnState,
        fallbackPreviousResponseId,
      })
      return {
        result,
        previewContent,
        assistantStatus: candidate.status,
      }
    }

    const tryRecoverFromTurnState = async (
      turnState: GatewayTurnState
    ): Promise<{
      recovered: boolean
      inProgress: boolean
      terminal: boolean
      result?: ChatTurnResult
    }> => {
      if (turnState.status === "completed") {
        const recovered = await this.persistRecoveredCompletedTurn({
          conversationId,
          sessionId,
          turnState,
          fallbackPreviousResponseId,
        })
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
      for (let attempt = 0; attempt < PENDING_RECOVERY_COMPLETION_FETCH_MAX_ATTEMPTS; attempt += 1) {
        const recovered = await tryRecoverFromMessages()
        latestPreview = recovered.previewContent || latestPreview
        if (recovered.result) {
          return {
            recovered: true,
            previewContent: latestPreview,
            result: recovered.result,
          }
        }
        if (attempt < PENDING_RECOVERY_COMPLETION_FETCH_MAX_ATTEMPTS - 1) {
          await waitForRetryDelay(PENDING_RECOVERY_COMPLETION_FETCH_DELAY_MS)
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

    let sessionState = await this.getGatewayRecoveryClient().querySessionState(sessionId)
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
      const activeTurnState = await this.getGatewayRecoveryClient().queryTurnState(sessionId, activeClientTurnId)
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

    for (let attempt = 0; attempt < this.turnRecoveryPollInProgressMaxAttempts; attempt += 1) {
      await waitForRetryDelay(this.turnRecoveryPollInProgressDelayMs)
      const recovered = await tryRecoverFromMessages()
      latestPreviewContent = recovered.previewContent || latestPreviewContent
      if (recovered.result) {
        return {
          recovered: true,
          previewContent: latestPreviewContent || undefined,
          result: recovered.result,
        }
      }
      sessionState = await this.getGatewayRecoveryClient().querySessionState(sessionId)
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
        const activeTurnState = await this.getGatewayRecoveryClient().queryTurnState(sessionId, activeClientTurnId)
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

  private async persistRecoveredCompletedTurn(input: {
    conversationId: string
    sessionId: string
    turnState: GatewayTurnState
    fallbackPreviousResponseId: string
  }): Promise<ChatTurnResult | null> {
    const targetResponseId = input.turnState.responseId.trim()
    if (!targetResponseId) {
      return null
    }

    const recoveredRows = await this.getGatewayRecoveryClient().querySessionMessages(
      input.sessionId,
      input.fallbackPreviousResponseId
    )
    const candidate =
      recoveredRows.find(
        (row) => row.role === "assistant" && row.responseId.trim() === targetResponseId
      ) ||
      recoveredRows
        .filter((row) => row.role === "assistant")
        .sort((a, b) => a.createdAt - b.createdAt)
        .at(-1)
    if (!candidate) {
      return null
    }

    const existingMessages = await this.repository.listMessages(input.conversationId)
    const existingAssistant = existingMessages.find(
      (row) => row.role === "assistant" && (row.responseId || "").trim() === targetResponseId
    )
    const fallbackPreviousResponseId = input.fallbackPreviousResponseId.trim()
    const nextAssistant: ChatMessage = {
      id: existingAssistant?.id || candidate.id || targetResponseId || `asst_${crypto.randomUUID()}`,
      role: "assistant",
      content: candidate.content || existingAssistant?.content || "",
      createdAt: existingAssistant?.createdAt || candidate.createdAt || Date.now(),
      responseId: targetResponseId,
      previousResponseId:
        candidate.previousResponseId || existingAssistant?.previousResponseId || fallbackPreviousResponseId || undefined,
      status: "completed",
      reasoningEvents: existingAssistant?.reasoningEvents,
      reasoningDurationSeconds: existingAssistant?.reasoningDurationSeconds,
      research: existingAssistant?.research,
    }

    if (existingAssistant) {
      const shouldUpdate =
        existingAssistant.content !== nextAssistant.content ||
        (existingAssistant.previousResponseId || "") !== (nextAssistant.previousResponseId || "") ||
        (existingAssistant.status || "completed") !== "completed"
      if (shouldUpdate) {
        await this.repository.updateMessage(input.conversationId, nextAssistant)
      }
    } else {
      await this.repository.appendMessage(input.conversationId, nextAssistant)
    }

    const sessionState = await this.getGatewayRecoveryClient().querySessionState(input.sessionId)
    const existingConversations = await this.repository.listConversations()
    const currentConversation = existingConversations.find((item) => item.id === input.conversationId)
    const currentTitle = currentConversation?.title || ""
    const anchors: ChatAnchors = {
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      lastResponseId:
        sessionState?.lastResponseId.trim() || targetResponseId || fallbackPreviousResponseId,
    }
    await this.repository.upsertConversation(
      createConversationRecord(
        input.conversationId,
        currentTitle || fallbackConversationTitleFromPrompt(nextAssistant.content),
        anchors,
        Date.now()
      )
    )

    return {
      assistantMessage: nextAssistant,
      anchors,
    }
  }

  private async attemptTurnRecovery(input: {
    conversationId: string
    sessionId: string
    clientTurnId: string
    fallbackPreviousResponseId: string
    allowRetryFromNotFound: boolean
  }): Promise<TurnRecoveryOutcome> {
    const normalizedSessionId = input.sessionId.trim()
    const normalizedClientTurnId = input.clientTurnId.trim()
    if (!normalizedSessionId || !normalizedClientTurnId) {
      return { kind: "none" }
    }

    let turnState = await this.getGatewayRecoveryClient().queryTurnState(normalizedSessionId, normalizedClientTurnId)
    if (!turnState) {
      return { kind: "none" }
    }

    if (turnState.status === "in_progress") {
      for (let attempt = 0; attempt < this.turnRecoveryPollInProgressMaxAttempts; attempt += 1) {
        await waitForRetryDelay(this.turnRecoveryPollInProgressDelayMs)
        const next = await this.getGatewayRecoveryClient().queryTurnState(normalizedSessionId, normalizedClientTurnId)
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
      const recovered = await this.persistRecoveredCompletedTurn({
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
      const sessionState = await this.getGatewayRecoveryClient().querySessionState(normalizedSessionId)
      const activeClientTurnId = sessionState?.activeClientTurnId.trim() || ""
      const sameTurnActive = !activeClientTurnId || activeClientTurnId === normalizedClientTurnId
      if (sessionState?.inProgress && sameTurnActive) {
        return { kind: "in_progress" }
      }
      return { kind: "none" }
    }

    return { kind: "none" }
  }

  private async renewAssetUrl(assetId: string): Promise<RenewedAssetUrlPayload | null> {
    const normalizedAssetId = assetId.trim()
    if (!normalizedAssetId) {
      return null
    }
    const renewUrl = `${this.gatewayBaseUrl}/assets/${encodeURIComponent(normalizedAssetId)}/url?ttl=${ASSET_URL_RENEW_TTL_SECONDS}`

    try {
      const response = await this.runtimeFetch(renewUrl, {
        method: "GET",
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
      })
      if (!response.ok) {
        return null
      }
      const rawText = await response.text().catch(() => "")
      if (!rawText.trim()) {
        return null
      }
      return parseRenewedAssetUrlResponse(rawText)
    } catch {
      return null
    }
  }

  private async hydrateGeneratedImageCards(
    cards: ChatCardAttachmentPayload[],
    sharedRenewCache?: Map<string, Promise<RenewedAssetUrlPayload | null>>
  ): Promise<void> {
    if (cards.length === 0) {
      return
    }

    const renewCache = sharedRenewCache || new Map<string, Promise<RenewedAssetUrlPayload | null>>()
    const renewOnce = (assetId: string): Promise<RenewedAssetUrlPayload | null> => {
      const normalizedAssetId = assetId.trim()
      if (!normalizedAssetId) {
        return Promise.resolve(null)
      }
      const existing = renewCache.get(normalizedAssetId)
      if (existing) {
        return existing
      }
      const next = this.renewAssetUrl(normalizedAssetId)
      renewCache.set(normalizedAssetId, next)
      return next
    }

    await Promise.all(
      cards.map(async (item, index) => {
        if ((item.type || "").toLowerCase() !== "generated_image") {
          return
        }
        const current = cards[index]
        const renewAssetId = await resolveRenewAssetIdForCard(current)
        if (!renewAssetId) {
          return
        }
        const currentMeta = readCardAssetMeta(current)
        if (currentMeta.asset_id !== renewAssetId) {
          cards[index] = withCardAssetMeta(current, {
            asset_id: renewAssetId,
          })
        }
        if (!shouldRenewCardAssetUrl(cards[index])) {
          return
        }

        const renewed = await renewOnce(renewAssetId)
        if (!renewed) {
          return
        }
        cards[index] = withCardAssetMetadata(cards[index], renewed)
      })
    )
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
    await this.repository.upsertConversation(
      createConversationRecord(
        conversationId,
        currentTitle || fallbackConversationTitleFromPrompt(input.text),
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
      const previousResponseId =
        !anchoredSessionId && fallbackPreviousResponseId ? fallbackPreviousResponseId : ""
      const requestBodyPayload: Record<string, unknown> = {
        model: input.model,
        session_id: sessionId,
        client_turn_id: clientTurnId,
        stream: true,
      }
      if (isRegenerate) {
        requestBodyPayload["x_grok"] = {
          regenerate: true,
          target_response_id: regenerateTargetResponseId,
        }
      } else {
        const contentBlocks = await buildResponsesInputContent(input.text, input.attachments)
        requestBodyPayload["input"] = [
          {
            role: "user",
            content: contentBlocks,
          },
        ]
        if (previousResponseId) {
          requestBodyPayload["previous_response_id"] = previousResponseId
        }
      }
      let upstreamConversationTitle = ""
      let assistantText = ""
      let gatewayFinalMessage = ""
      const collectedWebSearchMeta: WebSearchToolMeta[] = []
      const collectedWebSearchSeen = new Set<string>()
      const collectedCards: ChatCardAttachmentPayload[] = []
      const collectedCardIds = new Set<string>()
      const generatedImageIndexByCanonical = new Map<string, number>()
      const generatedImageIndexByAssetId = new Map<string, number>()
      const collectedReasoningEvents: ChatReasoningEventDetail[] = []
      let collectedResearch: ChatDeepSearchResearch | undefined
      let hasStructuredGeneratedImages = false
      let hasModeratedGeneratedImages = false
      let hasVisibleAssistantDelta = false
      let reasoningStartedAtMs: number | null = null
      let reasoningEndedAtMs: number | null = null

      // Track thinking state: image_search tools never send raw_function_result,
      // so we detect thinking->output transition and emit synthetic tool_results.
      let wasThinking = false
      const pendingToolUsageCardIds = new Set<string>()

      const appendWebSearchMeta = (items: WebSearchToolMeta[]) => {
        for (const item of items) {
          const dedupeKey = `${item.query}\u0000${item.numResults}`
          if (collectedWebSearchSeen.has(dedupeKey)) {
            continue
          }
          collectedWebSearchSeen.add(dedupeKey)
          collectedWebSearchMeta.push(item)
        }
      }

      const appendCards = (items: ChatCardAttachmentPayload[]) => {
        for (const item of items) {
          const isGeneratedImage = (item.type || "").toLowerCase() === "generated_image"
          const sourceBeforeNormalize = (item.image?.original || item.url || "").trim()
          const inferredAssetId = inferGeneratedImageAssetId(sourceBeforeNormalize)
          const inferredLocalAssetId = isLocalRenewableImageAssetId(inferredAssetId)
            ? inferredAssetId
            : undefined
          const itemMeta = readCardAssetMeta(item)
          const normalizedItem =
            isGeneratedImage && !itemMeta.asset_id && inferredLocalAssetId
              ? withCardAssetMeta(item, {
                  asset_id: inferredLocalAssetId,
                })
              : item
          let canonicalGeneratedKey = ""
          let nextIsPart = false
          const normalizedMeta = readCardAssetMeta(normalizedItem)
          const generatedAssetId = isGeneratedImage
            ? normalizedMeta.asset_id || inferredLocalAssetId || normalizedMeta.assetId || inferredAssetId
            : ""
          if (isGeneratedImage) {
            hasStructuredGeneratedImages = true
            const canonical = canonicalizeGeneratedImagePath(sourceBeforeNormalize)
            canonicalGeneratedKey = canonical.key
            nextIsPart = canonical.isPart
          }

          const normalized = normalizeCardAttachmentUrls(normalizedItem, this.apiUrl)
          if (isGeneratedImage && generatedAssetId) {
            const existingByAssetIndex = generatedImageIndexByAssetId.get(generatedAssetId)
            if (
              typeof existingByAssetIndex === "number" &&
              existingByAssetIndex >= 0 &&
              existingByAssetIndex < collectedCards.length
            ) {
              const existing = collectedCards[existingByAssetIndex]
              const preferred = preferGeneratedCardByUrlQuality(existing, normalized, this.apiUrl)
              if (preferred.id !== existing.id && collectedCardIds.has(preferred.id)) {
                continue
              }
              collectedCardIds.delete(existing.id)
              collectedCardIds.add(preferred.id)
              collectedCards[existingByAssetIndex] = preferred
              if (canonicalGeneratedKey) {
                generatedImageIndexByCanonical.set(canonicalGeneratedKey, existingByAssetIndex)
              }
              generatedImageIndexByAssetId.set(generatedAssetId, existingByAssetIndex)
              continue
            }
          }

          if (isGeneratedImage && canonicalGeneratedKey) {
            const existingIndex = generatedImageIndexByCanonical.get(canonicalGeneratedKey)
            if (typeof existingIndex === "number" && existingIndex >= 0 && existingIndex < collectedCards.length) {
              const existing = collectedCards[existingIndex]
              const existingSource = (existing.image?.original || existing.url || "").trim()
              const existingIsPart = canonicalizeGeneratedImagePath(existingSource).isPart
              // Same generated image: always prefer final image over -part-* intermediates.
              if (existingIsPart && !nextIsPart) {
                if (existing.id !== normalized.id && collectedCardIds.has(normalized.id)) {
                  continue
                }
                collectedCardIds.delete(existing.id)
                collectedCardIds.add(normalized.id)
                collectedCards[existingIndex] = normalized
                if (generatedAssetId) {
                  generatedImageIndexByAssetId.set(generatedAssetId, existingIndex)
                }
              }
              continue
            }
          }
          if (collectedCardIds.has(normalized.id)) {
            continue
          }
          collectedCardIds.add(normalized.id)
          collectedCards.push(normalized)
          if (isGeneratedImage && canonicalGeneratedKey) {
            generatedImageIndexByCanonical.set(canonicalGeneratedKey, collectedCards.length - 1)
          }
          if (isGeneratedImage && generatedAssetId) {
            generatedImageIndexByAssetId.set(generatedAssetId, collectedCards.length - 1)
          }
        }
      }

      let idleRetryAttempts = 0
      let anchorRecoveryAttempts = 0
      let turnNotFoundRetryAttempts = 0
      let turnInProgressRetryAttempts = 0
      while (true) {
        const requestBody = JSON.stringify(requestBodyPayload)
        let response: Response
        try {
          response = await this.runtimeFetch(this.apiUrl, {
            method: "POST",
            headers: this.createGatewayAuthHeaders({
              "Content-Type": "application/json",
              "Idempotency-Key": clientTurnId,
            }),
            body: requestBody,
            signal,
          })
        } catch (error) {
          if (!isRegenerate) {
            const recovery = await this.attemptTurnRecovery({
              conversationId,
              sessionId,
              clientTurnId,
              fallbackPreviousResponseId,
              allowRetryFromNotFound:
                turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts,
            })
            if (recovery.kind === "completed") {
              emitCompleted(recovery.result, recovery.result.assistantMessage.responseId)
              return
            }
            if (
              recovery.kind === "retry_send" &&
              turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts
            ) {
              turnNotFoundRetryAttempts += 1
              continue
            }
            if (recovery.kind === "in_progress") {
              if (turnInProgressRetryAttempts < this.turnInProgressRetryMaxAttempts) {
                turnInProgressRetryAttempts += 1
                await waitForRetryDelay(this.turnInProgressRetryDelayMs, signal)
                continue
              }
              emitFailed("turn_in_progress", "turn_is_still_in_progress")
              return
            }
          }
          throw error
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => "")
          const errorCode = extractGatewayErrorCode(errorText)
          const currentPreviousResponseId =
            typeof requestBodyPayload["previous_response_id"] === "string"
              ? requestBodyPayload["previous_response_id"].trim()
              : ""
          const shouldRetryFromAnchorConflict =
            !isRegenerate &&
            currentPreviousResponseId.length > 0 &&
            anchorRecoveryAttempts < 1 &&
            ANCHOR_RECOVERY_ERROR_CODES.has(errorCode)
          if (shouldRetryFromAnchorConflict) {
            delete requestBodyPayload["previous_response_id"]
            anchorRecoveryAttempts += 1
            continue
          }
          const shouldTrySessionRecovery =
            !isRegenerate &&
            (TURN_RECOVERY_HTTP_RETRYABLE_CODES.has(errorCode) ||
              ANCHOR_RECOVERY_ERROR_CODES.has(errorCode) ||
              response.status >= 500 ||
              response.status === 409)
          if (shouldTrySessionRecovery) {
            const recovery = await this.attemptTurnRecovery({
              conversationId,
              sessionId,
              clientTurnId,
              fallbackPreviousResponseId,
              allowRetryFromNotFound:
                turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts,
            })
            if (recovery.kind === "completed") {
              emitCompleted(recovery.result, recovery.result.assistantMessage.responseId)
              return
            }
            if (
              recovery.kind === "retry_send" &&
              turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts
            ) {
              turnNotFoundRetryAttempts += 1
              continue
            }
            if (recovery.kind === "in_progress") {
              if (turnInProgressRetryAttempts < this.turnInProgressRetryMaxAttempts) {
                turnInProgressRetryAttempts += 1
                await waitForRetryDelay(this.turnInProgressRetryDelayMs, signal)
                continue
              }
              emitFailed("turn_in_progress", "turn_is_still_in_progress")
              return
            }
          }
          emitFailed(`http_${response.status}`, errorText || `HTTP ${response.status}`)
          return
        }

        if (!response.body) {
          if (!isRegenerate) {
            const recovery = await this.attemptTurnRecovery({
              conversationId,
              sessionId,
              clientTurnId,
              fallbackPreviousResponseId,
              allowRetryFromNotFound:
                turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts,
            })
            if (recovery.kind === "completed") {
              emitCompleted(recovery.result, recovery.result.assistantMessage.responseId)
              return
            }
            if (
              recovery.kind === "retry_send" &&
              turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts
            ) {
              turnNotFoundRetryAttempts += 1
              continue
            }
            if (recovery.kind === "in_progress") {
              if (turnInProgressRetryAttempts < this.turnInProgressRetryMaxAttempts) {
                turnInProgressRetryAttempts += 1
                await waitForRetryDelay(this.turnInProgressRetryDelayMs, signal)
                continue
              }
              emitFailed("turn_in_progress", "turn_is_still_in_progress")
              return
            }
          }
          emitFailed("no_body", "Response has no body")
          return
        }

        // Read the streaming response as concatenated JSON objects
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let lastChunkAt = Date.now()
        let lastHeartbeatSentAt = 0
        const readChunkWithTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null
          const timeoutPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new StreamIdleTimeoutError(this.streamIdleTimeoutMs))
            }, this.streamIdleTimeoutMs)
          })
          try {
            return await Promise.race([reader.read(), timeoutPromise])
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle)
            }
          }
        }

        try {
          while (true) {
            const { done, value } = await readChunkWithTimeout()
            if (done) {
              break
            }

            const chunkArrivedAt = Date.now()
            const idleMs = Math.max(0, chunkArrivedAt - lastChunkAt)
            if (
              lastHeartbeatSentAt === 0 ||
              chunkArrivedAt - lastHeartbeatSentAt >= STREAM_HEARTBEAT_INTERVAL_MS
            ) {
              emitHeartbeat(idleMs, gatewayResponseId)
              lastHeartbeatSentAt = chunkArrivedAt
            }
            lastChunkAt = chunkArrivedAt

            buffer += decoder.decode(value, { stream: true })

            // Parse complete JSON objects from the buffer
            const segments = parseJsonObjectStrings(buffer)
            if (segments.length === 0) {
              continue
            }

            // Find the position of the last parsed segment to trim the buffer
            let lastEnd = 0
            for (const segment of segments) {
              const idx = buffer.indexOf(segment, lastEnd)
              if (idx >= 0) {
                lastEnd = idx + segment.length
              }
            }
            buffer = buffer.slice(lastEnd)

            // Process each parsed JSON object — batch events per network chunk
            // to minimize React re-renders (prevents image flickering)
            let chunkDelta = ""
            const chunkReasoningDetails: ChatReasoningEventDetail[] = []

            for (const segment of segments) {
              let parsed: unknown
              try {
                parsed = JSON.parse(segment)
              } catch {
                continue
              }

              // Detect thinking -> output transition
              const chunkIsThinking = extractChunkIsThinking(parsed)
              if (chunkIsThinking === true) {
                wasThinking = true
                if (!hasVisibleAssistantDelta && !reasoningStartedAtMs) {
                  reasoningStartedAtMs = Date.now()
                  reasoningEndedAtMs = null
                }
              } else if (chunkIsThinking === false && wasThinking && pendingToolUsageCardIds.size > 0) {
                for (const id of pendingToolUsageCardIds) {
                  chunkReasoningDetails.push({
                    kind: "tool_result",
                    result: { toolUsageCardId: id, isThinking: false },
                  })
                }
                pendingToolUsageCardIds.clear()
                wasThinking = false
                if (reasoningStartedAtMs && !reasoningEndedAtMs) {
                  reasoningEndedAtMs = Date.now()
                }
              }

              // Extract reasoning events
              const reasoningEvents = extractReasoningEventsFromRawChunk(parsed)
              for (const detail of reasoningEvents) {
                if (detail.kind === "tool_usage") {
                  pendingToolUsageCardIds.add(detail.usage.toolUsageCardId)
                }
                if (detail.kind === "tool_result" && detail.result.toolUsageCardId) {
                  pendingToolUsageCardIds.delete(detail.result.toolUsageCardId)
                }
                if (!hasVisibleAssistantDelta && !reasoningStartedAtMs) {
                  reasoningStartedAtMs = Date.now()
                  reasoningEndedAtMs = null
                }
                chunkReasoningDetails.push(detail)
              }

              // Extract response ID
              const nextResponseId = extractGatewayResponseIdFromRawChunk(parsed)
              if (nextResponseId) {
                gatewayResponseId = nextResponseId
              }

              // Extract final message
              const nextFinalMessage = extractGatewayFinalMessageFromRawChunk(parsed)
              if (nextFinalMessage) {
                gatewayFinalMessage = nextFinalMessage
              }

              // Extract title
              const nextTitle = extractResponseNewTitleFromRawChunk(parsed)
              if (nextTitle) {
                upstreamConversationTitle = nextTitle
              }

              // Extract web search meta & cards (collect only)
              appendWebSearchMeta(extractWebSearchToolMetaFromRawChunk(parsed))
              appendCards(extractCardAttachmentsFromRawChunk(parsed))
              collectedResearch = mergeResearchPayload(
                collectedResearch,
                extractDeepSearchResearchFromRawChunk(parsed)
              )
              if (extractGeneratedImageModeratedFromRawChunk(parsed)) {
                hasModeratedGeneratedImages = true
              }

              // Accumulate text delta (emit once after all segments)
              const delta = extractGatewayTextDeltaFromRawChunk(parsed)
              if (
                delta &&
                !hasStructuredGeneratedImages &&
                !isGeneratedImageNarration(delta)
              ) {
                assistantText += delta
                chunkDelta += delta
              }
            }

            // Emit batched events — React 18 batches these into a single render
            for (const detail of chunkReasoningDetails) {
              collectedReasoningEvents.push(detail)
              emitReasoning(detail, readReasoningEventResponseId(detail))
            }
            if (chunkDelta) {
              if (!hasVisibleAssistantDelta && chunkDelta.trim()) {
                hasVisibleAssistantDelta = true
                if (reasoningStartedAtMs && !reasoningEndedAtMs) {
                  reasoningEndedAtMs = Date.now()
                }
              }
              emitDelta(chunkDelta, gatewayResponseId)
            }
          }
          break
        } catch (error) {
          const shouldRetryFromIdleTimeout =
            error instanceof StreamIdleTimeoutError &&
            idleRetryAttempts < this.streamIdleRetryMaxAttempts &&
            !assistantText.trim() &&
            !gatewayFinalMessage.trim() &&
            collectedReasoningEvents.length === 0 &&
            !hasStructuredGeneratedImages &&
            !hasModeratedGeneratedImages
          if (shouldRetryFromIdleTimeout) {
            idleRetryAttempts += 1
            await waitForRetryDelay(this.streamIdleRetryDelayMs, signal)
            continue
          }
          if (!isRegenerate) {
            const recovery = await this.attemptTurnRecovery({
              conversationId,
              sessionId,
              clientTurnId,
              fallbackPreviousResponseId,
              allowRetryFromNotFound:
                turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts,
            })
            if (recovery.kind === "completed") {
              emitCompleted(recovery.result, recovery.result.assistantMessage.responseId)
              return
            }
            if (
              recovery.kind === "retry_send" &&
              turnNotFoundRetryAttempts < this.turnRecoveryNotFoundRetryMaxAttempts
            ) {
              turnNotFoundRetryAttempts += 1
              continue
            }
            if (recovery.kind === "in_progress") {
              if (turnInProgressRetryAttempts < this.turnInProgressRetryMaxAttempts) {
                turnInProgressRetryAttempts += 1
                await waitForRetryDelay(this.turnInProgressRetryDelayMs, signal)
                continue
              }
              emitFailed("turn_in_progress", "turn_is_still_in_progress", gatewayResponseId)
              return
            }
          }
          throw error
        } finally {
          reader.releaseLock()
        }
      }

      const renewCache = new Map<string, Promise<RenewedAssetUrlPayload | null>>()
      const finalizedGeneratedMedia = await finalizeGeneratedMediaArtifacts({
        cards: collectedCards,
        reasoningEvents: collectedReasoningEvents,
        apiUrl: this.apiUrl,
        hydrateGeneratedImageCards: (cards, sharedRenewCache) =>
          this.hydrateGeneratedImageCards(cards, sharedRenewCache),
        renewCache,
      })
      collectedCards.splice(0, collectedCards.length, ...finalizedGeneratedMedia.cards)
      const normalizedReasoningEvents = finalizedGeneratedMedia.reasoningEvents

      const citationCardsFromAttachments = collectedCards
        .map((card) => toCitationCardFromAttachment(card))
        .filter((row): row is ChatCitationCard => Boolean(row))
      collectedResearch = mergeResearchPayload(collectedResearch, {
        citationCards: citationCardsFromAttachments,
      })

      if (hasStructuredGeneratedImages) {
        assistantText = extractGeneratedImageMarkdown(collectedCards)
        gatewayFinalMessage = ""
      }

      if (hasModeratedGeneratedImages) {
        const notice = `_${GENERATED_IMAGE_MODERATED_NOTICE}_`
        assistantText = assistantText.trim() ? `${assistantText}\n\n${notice}` : notice
        gatewayFinalMessage = ""
      }

      // Use final message as fallback if no accumulated text
      if (!assistantText && gatewayFinalMessage && !isGeneratedImageNarration(gatewayFinalMessage)) {
        assistantText = gatewayFinalMessage
      }

      const inlineCitationsFromText = extractInlineCitationsFromText(gatewayFinalMessage || assistantText)
      if (inlineCitationsFromText.length > 0) {
        collectedResearch = mergeResearchPayload(collectedResearch, {
          inlineCitations: inlineCitationsFromText,
        })
      }

      const assistantContent = appendToolMeta(assistantText, {
        webSearch: collectedWebSearchMeta,
        cards: collectedCards,
      })
      const nowMs = Date.now()
      const durationFromResearch = resolveReasoningDurationFromResearch(collectedResearch)
      const durationFromLocalWindow = resolveReasoningDurationFromLocalWindow(
        reasoningStartedAtMs,
        reasoningEndedAtMs,
        nowMs
      )
      const finalDurationSeconds =
        durationFromResearch ||
        durationFromLocalWindow ||
        Math.max(1, Math.round((nowMs - streamStartedAt) / 1000))
      const reasoningEventCount = normalizedReasoningEvents?.length || 0
      const shouldPersistReasoningDuration =
        reasoningEventCount > 0 || hasAnyThinkTag(assistantText)

      const assistantMessage: ChatMessage = {
        id: gatewayResponseId || `asst_${crypto.randomUUID()}`,
        role: "assistant",
        content: assistantContent,
        createdAt: Date.now(),
        reasoningEvents: reasoningEventCount > 0 ? normalizedReasoningEvents : undefined,
        reasoningDurationSeconds: shouldPersistReasoningDuration ? finalDurationSeconds : undefined,
        research: collectedResearch,
        responseId: gatewayResponseId || undefined,
        previousResponseId: input.anchors.lastResponseId || undefined,
        status: "completed",
      }
      const anchors: ChatAnchors = {
        sessionId,
        conversationId,
        lastResponseId: gatewayResponseId || input.anchors.lastResponseId || "",
      }
      const existingConversations = await this.repository.listConversations()
      const currentConversation = existingConversations.find((item) => item.id === conversationId)
      const currentTitle = currentConversation?.title || ""
      const resolvedTitle =
        resolveConversationTitle(upstreamConversationTitle, currentTitle) ||
        fallbackConversationTitleFromPrompt(input.text)
      await this.persistAssistantTurnResult({
        conversationId,
        assistantMessage,
        anchors,
        resolvedTitle,
        commitTime: Date.now(),
        regenerateTargetResponseId: isRegenerate ? regenerateTargetResponseId : undefined,
      })

      emitCompleted({
          assistantMessage,
          anchors,
        }, assistantMessage.responseId)
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
