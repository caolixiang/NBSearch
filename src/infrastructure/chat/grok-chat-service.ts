import type { AppConfig } from "../../app/contracts"
import type { ChatService } from "../../domain/chat/service"
import type {
  ChatAnchors,
  ChatCardAttachmentPayload,
  ChatMessage,
  ChatReasoningEventDetail,
  ChatStreamEvent,
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
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractReasoningEventsFromRawChunk,
  extractResponseNewTitleFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
  parseJsonObjectStrings,
  resolveConversationTitle,
} from "./chunk-parsers"

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

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

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

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function isGrokAssetHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  if (!host) {
    return false
  }
  return host === "assets.grok.com" || host === "grok.com" || host.endsWith(".grok.com") || host.endsWith(".x.ai")
}

function toEncodedImagePathToken(raw: string): string {
  const value = raw.trim()
  if (!value) {
    return ""
  }
  if (/^(?:u_|p_)[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9]+)?$/.test(value)) {
    return value
  }
  if (/^(?:image|video)_[0-9a-f]{64}$/i.test(value)) {
    return value
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      if (!isGrokAssetHost(parsed.hostname)) {
        return ""
      }
      return `u_${toBase64Url(parsed.toString())}`
    } catch {
      return ""
    }
  }

  let normalizedPath = value
  if (!normalizedPath.startsWith("/")) {
    normalizedPath = `/${normalizedPath}`
  }
  return `p_${toBase64Url(normalizedPath)}`
}

export function resolveGatewayMediaUrl(rawUrl: string, apiUrl: string): string {
  const url = rawUrl.trim()
  if (!url) {
    return ""
  }
  if (/^(?:data:|blob:)/i.test(url)) {
    return url
  }
  try {
    const gateway = new URL(apiUrl)
    if (url.startsWith("//")) {
      const absolute = `${gateway.protocol}${url}`
      const encoded = toEncodedImagePathToken(absolute)
      if (encoded) {
        return new URL(`/images/${encoded}`, gateway.origin).toString()
      }
      return absolute
    }
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url)
      if (parsed.origin === gateway.origin && parsed.pathname.startsWith("/images/")) {
        return parsed.toString()
      }
      if (parsed.origin === gateway.origin && parsed.pathname.startsWith("/users/")) {
        const encoded = toEncodedImagePathToken(parsed.pathname)
        if (encoded) {
          return new URL(`/images/${encoded}`, gateway.origin).toString()
        }
      }
      const encoded = toEncodedImagePathToken(parsed.toString())
      if (encoded) {
        return new URL(`/images/${encoded}`, gateway.origin).toString()
      }
      return parsed.toString()
    }
    if (url.startsWith("/images/")) {
      return new URL(url, gateway.origin).toString()
    }

    const shouldProxyAsAsset =
      /^(?:u_|p_)[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9]+)?$/.test(url) ||
      /^(?:image|video)_[0-9a-f]{64}$/i.test(url) ||
      /^\/?users\//i.test(url)
    if (shouldProxyAsAsset) {
      const encoded = toEncodedImagePathToken(url)
      if (encoded) {
        return new URL(`/images/${encoded}`, gateway.origin).toString()
      }
    }
    return new URL(`/${url.replace(/^\/+/, "")}`, gateway.origin).toString()
  } catch {
    return url
  }
}

function normalizeCardAttachmentUrls(card: ChatCardAttachmentPayload, apiUrl: string): ChatCardAttachmentPayload {
  const normalizedUrl = card.url ? resolveGatewayMediaUrl(card.url, apiUrl) : card.url
  const normalizedImage = card.image
    ? {
        ...card.image,
        original: card.image.original ? resolveGatewayMediaUrl(card.image.original, apiUrl) : card.image.original,
        thumbnail: card.image.thumbnail
          ? resolveGatewayMediaUrl(card.image.thumbnail, apiUrl)
          : card.image.thumbnail,
      }
    : undefined

  return {
    ...card,
    url: normalizedUrl,
    image: normalizedImage,
  }
}

function isGeneratedImageNarration(text: string): boolean {
  const value = text.trim()
  if (!value) {
    return false
  }
  if (/^i generated images? with the prompt[:：]/i.test(value)) {
    return true
  }
  if (/^i generated an image with the prompt[:：]/i.test(value)) {
    return true
  }
  if (/^我(?:已经|已)?根据提示.*生成了?图(?:像|片)/.test(value)) {
    return true
  }
  return false
}

function decodeBase64Url(input: string): string {
  const normalized = input.trim().replace(/-/g, "+").replace(/_/g, "/")
  if (!normalized) {
    return ""
  }
  const paddingLength = (4 - (normalized.length % 4)) % 4
  const padded = `${normalized}${"=".repeat(paddingLength)}`
  let binary = ""
  try {
    binary = globalThis.atob(padded)
  } catch {
    return ""
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  try {
    return new TextDecoder().decode(bytes).trim()
  } catch {
    return ""
  }
}

function resolveGeneratedImageSourcePath(raw: string): string {
  const value = raw.trim()
  if (!value) {
    return ""
  }
  const lower = value.toLowerCase()
  const marker = "/images/"
  const markerIndex = lower.indexOf(marker)
  if (markerIndex >= 0) {
    const encoded = decodeURIComponent(value.slice(markerIndex + marker.length).replace(/^\/+/, ""))
    if (encoded.startsWith("p_")) {
      const decoded = decodeBase64Url(encoded.slice(2))
      if (decoded) {
        return decoded
      }
    }
    if (encoded.startsWith("u_")) {
      const decoded = decodeBase64Url(encoded.slice(2))
      if (decoded) {
        try {
          return new URL(decoded).pathname || decoded
        } catch {
          return decoded
        }
      }
    }
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      return parsed.pathname || value
    } catch {
      return value
    }
  }
  return value
}

function canonicalizeGeneratedImagePath(raw: string): { key: string; isPart: boolean } {
  const sourcePath = resolveGeneratedImageSourcePath(raw)
  if (!sourcePath) {
    return { key: "", isPart: false }
  }
  const isPart = /-part-\d+(?=\/|$)/i.test(sourcePath)
  const key = sourcePath.replace(/-part-\d+(?=\/|$)/gi, "")
  return { key, isPart }
}

function extractGeneratedImageMarkdown(cards: ChatCardAttachmentPayload[]): string {
  if (cards.length === 0) {
    return ""
  }

  const preferredByCanonical = new Map<string, string>()
  const order: string[] = []

  for (const card of cards) {
    if ((card.type || "").toLowerCase() !== "generated_image") {
      continue
    }
    const raw = (card.image?.original || card.url || "").trim()
    if (!raw || !/^https?:\/\//i.test(raw)) {
      continue
    }
    const { key: canonical, isPart } = canonicalizeGeneratedImagePath(raw)
    if (!canonical) {
      continue
    }
    const existing = preferredByCanonical.get(canonical)
    if (!existing) {
      preferredByCanonical.set(canonical, raw)
      order.push(canonical)
      continue
    }
    const existingIsPart = canonicalizeGeneratedImagePath(existing).isPart
    // Prefer finalized asset URL over intermediate part-* URL.
    if (existingIsPart && !isPart) {
      preferredByCanonical.set(canonical, raw)
    }
  }

  const urls = order
    .map((key) => preferredByCanonical.get(key) || "")
    .filter((value) => value.length > 0)

  if (urls.length === 0) {
    return ""
  }

  return urls.map((url) => `![Generated Image](<${url}>)`).join("\n")
}

export class GrokChatService implements ChatService {
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly runtimeFetch: typeof fetch

  constructor(
    private readonly repository: AppRepository,
    config: AppConfig
  ) {
    this.apiUrl = normalizeApiBaseUrl(config.apiBaseUrl)
    this.apiKey = config.apiKey || ""
    this.runtimeFetch = createRuntimeFetch(fetch)
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    return this.repository.listMessages(conversationId)
  }

  async upsertAnchors(anchors: ChatAnchors): Promise<void> {
    const now = Date.now()
    const conversationId = anchors.conversationId || anchors.sessionId || `conv_${crypto.randomUUID()}`
    const existingConversations = await this.repository.listConversations()
    const currentTitle = existingConversations.find((item) => item.id === conversationId)?.title || ""
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
    const sessionId = input.anchors.sessionId?.trim() || `sess_${crypto.randomUUID()}`
    const userMessage = buildUserMessage(buildUserMessageText(input.text, input.attachments))

    await this.repository.appendMessage(conversationId, userMessage)

    const requestId = `req_${crypto.randomUUID()}`
    const streamStartedAt = Date.now()
    onEvent({ type: "started", requestId })

    try {
      const contentBlocks = await buildResponsesInputContent(input.text, input.attachments)
      const requestBody = JSON.stringify({
        model: input.model,
        input: [
          {
            role: "user",
            content: contentBlocks,
          },
        ],
        session_id: sessionId,
        stream: true,
      })

      const response = await this.runtimeFetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: requestBody,
        signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        onEvent({
          type: "failed",
          code: `http_${response.status}`,
          message: errorText || `HTTP ${response.status}`,
        })
        return
      }

      if (!response.body) {
        onEvent({
          type: "failed",
          code: "no_body",
          message: "Response has no body",
        })
        return
      }

      let upstreamConversationTitle = ""
      let assistantText = ""
      let gatewayResponseId = ""
      let gatewayFinalMessage = ""
      const collectedWebSearchMeta: WebSearchToolMeta[] = []
      const collectedWebSearchSeen = new Set<string>()
      const collectedCards: ChatCardAttachmentPayload[] = []
      const collectedCardIds = new Set<string>()
      const generatedImageIndexByCanonical = new Map<string, number>()
      const collectedReasoningEvents: ChatReasoningEventDetail[] = []
      let hasStructuredGeneratedImages = false

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
          let canonicalGeneratedKey = ""
          let nextIsPart = false
          if (isGeneratedImage) {
            hasStructuredGeneratedImages = true
            const canonical = canonicalizeGeneratedImagePath(sourceBeforeNormalize)
            canonicalGeneratedKey = canonical.key
            nextIsPart = canonical.isPart
          }

          const normalized = normalizeCardAttachmentUrls(item, this.apiUrl)
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
        }
      }

      // Read the streaming response as concatenated JSON objects
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

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
            } else if (chunkIsThinking === false && wasThinking && pendingToolUsageCardIds.size > 0) {
              for (const id of pendingToolUsageCardIds) {
                chunkReasoningDetails.push({
                  kind: "tool_result",
                  result: { toolUsageCardId: id, isThinking: false },
                })
              }
              pendingToolUsageCardIds.clear()
              wasThinking = false
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
            onEvent({ type: "reasoning", detail })
          }
          if (chunkDelta) {
            onEvent({ type: "delta", textDelta: chunkDelta })
          }
        }
      } finally {
        reader.releaseLock()
      }

      if (hasStructuredGeneratedImages) {
        assistantText = extractGeneratedImageMarkdown(collectedCards)
        gatewayFinalMessage = ""
      }

      // Use final message as fallback if no accumulated text
      if (!assistantText && gatewayFinalMessage && !isGeneratedImageNarration(gatewayFinalMessage)) {
        assistantText = gatewayFinalMessage
      }

      const assistantContent = appendToolMeta(assistantText, {
        webSearch: collectedWebSearchMeta,
        cards: collectedCards,
      })
      const finalDurationSeconds = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000))
      const shouldPersistReasoningDuration =
        collectedReasoningEvents.length > 0 || hasAnyThinkTag(assistantText)

      const assistantMessage: ChatMessage = {
        id: gatewayResponseId || `asst_${crypto.randomUUID()}`,
        role: "assistant",
        content: assistantContent,
        createdAt: Date.now(),
        reasoningEvents: collectedReasoningEvents.length > 0 ? collectedReasoningEvents : undefined,
        reasoningDurationSeconds: shouldPersistReasoningDuration ? finalDurationSeconds : undefined,
        responseId: gatewayResponseId || undefined,
        previousResponseId: input.anchors.lastResponseId || undefined,
        status: "completed",
      }
      await this.repository.appendMessage(conversationId, assistantMessage)

      const anchors: ChatAnchors = {
        sessionId,
        conversationId,
        lastResponseId: gatewayResponseId || input.anchors.lastResponseId || "",
      }
      const existingConversations = await this.repository.listConversations()
      const currentTitle = existingConversations.find((item) => item.id === conversationId)?.title || ""
      await this.repository.upsertConversation(
        createConversationRecord(
          conversationId,
          resolveConversationTitle(upstreamConversationTitle, currentTitle),
          anchors,
          Date.now()
        )
      )

      onEvent({
        type: "completed",
        result: {
          assistantMessage,
          anchors,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error"
      onEvent({
        type: "failed",
        code: "chat_stream_error",
        message,
      })
    }
  }
}
