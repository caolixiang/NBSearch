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

const GENERATED_IMAGE_MODERATED_NOTICE = "内容已管理。请尝试一个不同的想法。"

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

  const hasPayload = Boolean(
    merged.requestMetadata ||
      merged.uiLayout ||
      (merged.deepsearchPreset || "").trim() ||
      (merged.thinkingStartTime || "").trim() ||
      (merged.thinkingEndTime || "").trim() ||
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
const STREAM_IDLE_TIMEOUT_MS = 20_000
const STREAM_IDLE_RETRY_MAX_ATTEMPTS = 1
const STREAM_IDLE_RETRY_DELAY_MS = 450

class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`stream_idle_timeout_${timeoutMs}ms`)
    this.name = "StreamIdleTimeoutError"
  }
}

async function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeoutHandle)
      cleanup()
      reject(new Error("aborted"))
    }
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

type RenewedAssetUrlPayload = {
  assetId: string
  rawUrl: string
  url: string
  urlExpiresAt: string
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

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function pickPreferredLocalGeneratedImageAssetId(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const normalized = (candidate || "").trim()
    if (!normalized) {
      continue
    }
    if (isLocalRenewableImageAssetId(normalized)) {
      return normalized
    }
  }
  return ""
}

function readCardUpstreamAssetId(value: Record<string, unknown>): string {
  const upstream = readTrimmedString(value.assetId)
  if (upstream && !isLocalRenewableImageAssetId(upstream)) {
    return upstream
  }
  return ""
}

function readCardLocalAssetId(value: Record<string, unknown>): string {
  const direct = readTrimmedString(value.asset_id)
  if (direct) {
    return direct
  }
  const legacy = readTrimmedString(value.assetId)
  if (isLocalRenewableImageAssetId(legacy)) {
    return legacy
  }
  return ""
}

function readCardRawUrl(value: Record<string, unknown>): string {
  return readTrimmedString(value.rawUrl) || readTrimmedString(value.raw_url)
}

function readCardUrlExpiresAt(value: Record<string, unknown>): string {
  return normalizeExpiresAtValue(value.urlExpiresAt) || normalizeExpiresAtValue(value.url_expires_at)
}

function readCardAssetMeta(card: ChatCardAttachmentPayload): {
  assetId: string
  asset_id: string
  rawUrl: string
  urlExpiresAt: string
} {
  const record = card as unknown as Record<string, unknown>
  return {
    assetId: readCardUpstreamAssetId(record),
    asset_id: readCardLocalAssetId(record),
    rawUrl: readCardRawUrl(record),
    urlExpiresAt: readCardUrlExpiresAt(record),
  }
}

function withCardAssetMeta(
  card: ChatCardAttachmentPayload,
  meta: {
    assetId?: string
    asset_id?: string
    rawUrl?: string
    urlExpiresAt?: string
  }
): ChatCardAttachmentPayload {
  const next = { ...card } as ChatCardAttachmentPayload & Record<string, unknown>
  if (typeof meta.assetId === "string") {
    next["assetId"] = meta.assetId
  }
  if (typeof meta.asset_id === "string") {
    next["asset_id"] = meta.asset_id
  }
  if (typeof meta.rawUrl === "string") {
    next["rawUrl"] = meta.rawUrl
  }
  if (typeof meta.urlExpiresAt === "string") {
    next["urlExpiresAt"] = meta.urlExpiresAt
  }
  return next
}

function toMillisFromIso(value: string): number | null {
  if (!value) {
    return null
  }
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) {
    return null
  }
  return millis
}

function readSearchParamCaseInsensitive(url: URL, key: string): string {
  const target = key.toLowerCase()
  for (const [name, value] of url.searchParams.entries()) {
    if (name.toLowerCase() === target) {
      return value.trim()
    }
  }
  return ""
}

function inferExpiresAtFromSignedUrl(url: string): string {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return ""
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ""
  }

  const amzDateRaw = readSearchParamCaseInsensitive(parsed, "X-Amz-Date")
  const amzExpiresRaw = readSearchParamCaseInsensitive(parsed, "X-Amz-Expires")
  if (/^\d{8}T\d{6}Z$/i.test(amzDateRaw) && /^\d+(?:\.\d+)?$/.test(amzExpiresRaw)) {
    const isoDate = `${amzDateRaw.slice(0, 4)}-${amzDateRaw.slice(4, 6)}-${amzDateRaw.slice(6, 8)}T${amzDateRaw.slice(9, 11)}:${amzDateRaw.slice(11, 13)}:${amzDateRaw.slice(13, 15)}Z`
    const baseMillis = Date.parse(isoDate)
    const expiresSeconds = Number.parseFloat(amzExpiresRaw)
    if (Number.isFinite(baseMillis) && Number.isFinite(expiresSeconds) && expiresSeconds > 0) {
      const iso = new Date(baseMillis + expiresSeconds * 1000).toISOString()
      return iso === "Invalid Date" ? "" : iso
    }
  }

  const expiresRaw = readSearchParamCaseInsensitive(parsed, "Expires")
  if (/^\d+(?:\.\d+)?$/.test(expiresRaw)) {
    const parsedExpires = Number.parseFloat(expiresRaw)
    if (Number.isFinite(parsedExpires)) {
      const millis = parsedExpires > 1_000_000_000_000 ? parsedExpires : parsedExpires * 1000
      const iso = new Date(millis).toISOString()
      return iso === "Invalid Date" ? "" : iso
    }
  }

  return ""
}

function normalizeExpiresAtValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000
    const iso = new Date(millis).toISOString()
    return iso === "Invalid Date" ? "" : iso
  }

  if (typeof value !== "string") {
    return ""
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return ""
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number.parseFloat(trimmed)
    if (!Number.isFinite(parsed)) {
      return ""
    }
    const millis = parsed > 1_000_000_000_000 ? parsed : parsed * 1000
    const iso = new Date(millis).toISOString()
    return iso === "Invalid Date" ? "" : iso
  }

  const millis = Date.parse(trimmed)
  if (!Number.isFinite(millis)) {
    return ""
  }
  const iso = new Date(millis).toISOString()
  return iso === "Invalid Date" ? "" : iso
}

export function parseRenewedAssetUrlResponse(raw: unknown): RenewedAssetUrlPayload | null {
  const queue: unknown[] = [raw]
  const seen = new Set<unknown>()

  while (queue.length > 0) {
    const candidate = queue.shift()
    if (!candidate || seen.has(candidate)) {
      continue
    }
    seen.add(candidate)

    if (typeof candidate === "string") {
      const text = candidate.trim()
      if (!text) {
        continue
      }
      try {
        queue.push(JSON.parse(text) as unknown)
      } catch {
        for (const segment of parseJsonObjectStrings(text)) {
          try {
            queue.push(JSON.parse(segment) as unknown)
          } catch {
            continue
          }
        }
      }
      continue
    }

    if (!isRecord(candidate)) {
      continue
    }

    const assetId = readTrimmedString(candidate.asset_id) || readTrimmedString(candidate.assetId)
    const rawUrl = readTrimmedString(candidate.raw_url) || readTrimmedString(candidate.rawUrl)
    const url = readTrimmedString(candidate.url)
    const explicitExpiresAt = normalizeExpiresAtValue(candidate.url_expires_at) || normalizeExpiresAtValue(candidate.urlExpiresAt)
    const inferredExpiresAt = inferExpiresAtFromSignedUrl(url)
    const urlExpiresAt =
      explicitExpiresAt ||
      inferredExpiresAt
    if (assetId && url) {
      return {
        assetId,
        rawUrl,
        url,
        urlExpiresAt,
      }
    }

    queue.push(candidate.result)
    queue.push(candidate.response)
    queue.push(candidate.data)

    if (isRecord(candidate.result)) {
      queue.push(candidate.result.response)
      queue.push(candidate.result.data)
    }
    if (isRecord(candidate.response)) {
      queue.push(candidate.response.data)
    }
    if (Array.isArray(candidate.data)) {
      for (const item of candidate.data) {
        queue.push(item)
      }
    }
  }

  return null
}

export function shouldRenewCardAssetUrl(
  card: ChatCardAttachmentPayload | (Record<string, unknown> & { url?: unknown }),
  now = Date.now()
): boolean {
  const record = card as unknown as Record<string, unknown>
  const localAssetId = readCardLocalAssetId(record)
  if (!localAssetId) {
    return false
  }
  const url = readTrimmedString(record.url)
  if (!url) {
    return true
  }
  if (!/^https?:\/\//i.test(url)) {
    return false
  }
  const rawUrl = readCardRawUrl(record)
  if (!rawUrl) {
    return false
  }
  const explicitExpiresAt = toMillisFromIso(readCardUrlExpiresAt(record))
  const inferredExpiresAt = toMillisFromIso(inferExpiresAtFromSignedUrl(url))
  const expiresAt = explicitExpiresAt ?? inferredExpiresAt
  if (!expiresAt) {
    // local/public URLs can have no expires_at and should not be renewed.
    return false
  }
  return expiresAt - now <= ASSET_URL_RENEW_THRESHOLD_MS
}

function withCardAssetMetadata(
  card: ChatCardAttachmentPayload,
  payload: RenewedAssetUrlPayload
): ChatCardAttachmentPayload {
  const nextUrl = payload.url.trim()
  const currentMeta = readCardAssetMeta(card)
  const nextRawUrl = payload.rawUrl.trim() || currentMeta.rawUrl
  const image = card.image
    ? {
        ...card.image,
        original: nextUrl || card.image.original,
      }
    : nextUrl
      ? { original: nextUrl }
      : undefined

  const nextCard = withCardAssetMeta(card, {
    assetId: currentMeta.assetId || undefined,
    asset_id: payload.assetId,
    rawUrl: nextRawUrl,
    urlExpiresAt: payload.urlExpiresAt,
  })

  return {
    ...nextCard,
    url: nextUrl || card.url,
    image,
  }
}

function collectCardUrlReplacements(
  beforeCards: ChatCardAttachmentPayload[],
  afterCards: ChatCardAttachmentPayload[]
): Map<string, string> {
  const replacements = new Map<string, string>()
  const beforeById = new Map<string, ChatCardAttachmentPayload>()
  for (const card of beforeCards) {
    const id = (card.id || "").trim()
    if (!id) {
      continue
    }
    beforeById.set(id, card)
  }

  for (const nextCard of afterCards) {
    const id = (nextCard.id || "").trim()
    if (!id) {
      continue
    }
    const previousCard = beforeById.get(id)
    if (!previousCard) {
      continue
    }

    const nextUrl = (nextCard.image?.original || nextCard.url || "").trim()
    if (!nextUrl || !/^https?:\/\//i.test(nextUrl)) {
      continue
    }

    const candidates = [
      (previousCard.image?.original || "").trim(),
      (previousCard.url || "").trim(),
    ]

    for (const previousUrl of candidates) {
      if (!previousUrl || previousUrl === nextUrl || !/^https?:\/\//i.test(previousUrl)) {
        continue
      }
      replacements.set(previousUrl, nextUrl)
    }
  }

  return replacements
}

function applyUrlReplacementsOutsideToolMeta(content: string, replacements: Map<string, string>): string {
  if (!content || replacements.size === 0) {
    return content
  }

  const entries = Array.from(replacements.entries())
    .filter(([from, to]) => Boolean(from) && Boolean(to) && from !== to)
    .sort((a, b) => b[0].length - a[0].length)

  if (entries.length === 0) {
    return content
  }

  const segments = content.split(/(<tool-meta>[\s\S]*?<\/tool-meta>)/gi)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] || ""
    if (/^<tool-meta>[\s\S]*<\/tool-meta>$/i.test(segment)) {
      continue
    }

    let nextSegment = segment
    for (const [from, to] of entries) {
      if (!nextSegment.includes(from)) {
        continue
      }
      nextSegment = nextSegment.split(from).join(to)
    }
    segments[index] = nextSegment
  }

  return segments.join("")
}

function cloneCardAttachmentPayload(card: ChatCardAttachmentPayload): ChatCardAttachmentPayload {
  return {
    ...card,
    image: card.image ? { ...card.image } : undefined,
  }
}

function appendMissingCardsFromReasoningEvents(
  cards: ChatCardAttachmentPayload[],
  events: ChatReasoningEventDetail[] | undefined
): ChatCardAttachmentPayload[] {
  if (!Array.isArray(events) || events.length === 0) {
    return []
  }

  const existingIds = new Set(
    cards
      .map((card) => (card.id || "").trim())
      .filter((id) => id.length > 0)
  )
  const appended: ChatCardAttachmentPayload[] = []

  for (const event of events) {
    if (event.kind !== "card_attachment") {
      continue
    }
    const cardId = (event.card.id || "").trim()
    if (!cardId || existingIds.has(cardId)) {
      continue
    }
    const cloned = cloneCardAttachmentPayload(event.card)
    cards.push(cloned)
    appended.push(cloned)
    existingIds.add(cardId)
  }

  return appended
}

function appendMissingGeneratedImageMarkdownOutsideToolMeta(content: string, urls: Set<string>): string {
  if (!content || urls.size === 0) {
    return content
  }

  const normalizedUrls = Array.from(urls)
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value))
  if (normalizedUrls.length === 0) {
    return content
  }

  const segments = content.split(/(<tool-meta>[\s\S]*?<\/tool-meta>)/gi)
  const textIndexes = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => !/^<tool-meta>[\s\S]*<\/tool-meta>$/i.test(segment))
    .map(({ index }) => index)
  if (textIndexes.length === 0) {
    return content
  }

  const plainContent = textIndexes.map((index) => segments[index] || "").join("\n")
  const missingUrls = normalizedUrls.filter((url) => !plainContent.includes(url))
  if (missingUrls.length === 0) {
    return content
  }

  const markdownLines = missingUrls.map((url) => `![Generated Image](<${url}>)`).join("\n")
  const targetIndex = textIndexes[0]
  const target = (segments[targetIndex] || "").trimEnd()
  segments[targetIndex] = target ? `${target}\n${markdownLines}\n` : `${markdownLines}\n`
  return segments.join("")
}

function collectGeneratedImageUrls(cards: ChatCardAttachmentPayload[]): Set<string> {
  const urls = new Set<string>()
  for (const card of cards) {
    if ((card.type || "").toLowerCase() !== "generated_image") {
      continue
    }
    const value = (card.image?.original || card.url || "").trim()
    if (!/^https?:\/\//i.test(value)) {
      continue
    }
    urls.add(value)
  }
  return urls
}

function mergeRenewedCardsIntoReasoningEvents(
  events: ChatReasoningEventDetail[] | undefined,
  renewedCardsById: Map<string, ChatCardAttachmentPayload>
): ChatReasoningEventDetail[] | undefined {
  if (!Array.isArray(events) || events.length === 0 || renewedCardsById.size === 0) {
    return events
  }

  let changed = false
  const nextEvents = events.map((event) => {
    if (event.kind !== "card_attachment") {
      return event
    }
    const cardId = (event.card.id || "").trim()
    if (!cardId) {
      return event
    }
    const renewed = renewedCardsById.get(cardId)
    if (!renewed) {
      return event
    }
    const before = JSON.stringify(event.card)
    const after = JSON.stringify(renewed)
    if (before === after) {
      return event
    }
    changed = true
    return {
      ...event,
      card: renewed,
    }
  })

  return changed ? nextEvents : events
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

function isGatewayImageProxyUrl(raw: string, apiUrl: string): boolean {
  const value = raw.trim()
  if (!value) {
    return false
  }
  try {
    const gateway = new URL(apiUrl)
    const target = new URL(value, gateway.origin)
    return target.origin === gateway.origin && target.pathname.startsWith("/images/")
  } catch {
    return false
  }
}

function preferGeneratedCardByUrlQuality(
  existing: ChatCardAttachmentPayload,
  next: ChatCardAttachmentPayload,
  apiUrl: string
): ChatCardAttachmentPayload {
  const existingUrl = (existing.image?.original || existing.url || "").trim()
  const nextUrl = (next.image?.original || next.url || "").trim()
  if (!existingUrl) {
    return next
  }
  if (!nextUrl) {
    return existing
  }
  const existingProxy = isGatewayImageProxyUrl(existingUrl, apiUrl)
  const nextProxy = isGatewayImageProxyUrl(nextUrl, apiUrl)
  if (existingProxy && !nextProxy) {
    return next
  }
  if (!existingProxy && nextProxy) {
    return existing
  }
  const existingMeta = readCardAssetMeta(existing)
  const nextMeta = readCardAssetMeta(next)
  const existingHasSignedMeta = Boolean(existingMeta.rawUrl && existingMeta.urlExpiresAt)
  const nextHasSignedMeta = Boolean(nextMeta.rawUrl && nextMeta.urlExpiresAt)
  if (!existingHasSignedMeta && nextHasSignedMeta) {
    return next
  }
  return existing
}

export function inferGeneratedImageAssetId(raw: string): string {
  const sourcePath = resolveGeneratedImageSourcePath(raw)
  if (!sourcePath) {
    return ""
  }
  const signedAssetMatch = sourcePath.match(/\/assets\/image\/(?:\d{4}\/\d{2}\/)?([0-9a-f]{64})(?:\.[^\/?#]+)?$/i)
  if (signedAssetMatch?.[1]) {
    return `image_${signedAssetMatch[1].toLowerCase()}`
  }
  const match = sourcePath.match(/\/generated\/([^\/]+?)(?:-part-\d+)?\/image(?:\.[^\/?#]+)?$/i)
  if (!match || !match[1]) {
    return ""
  }
  return match[1].trim()
}

function isLocalRenewableImageAssetId(value: string): boolean {
  return /^image_[0-9a-f]{64}$/i.test(value.trim())
}

async function sha256Hex(value: string): Promise<string> {
  if (!value) {
    return ""
  }
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    return ""
  }
  try {
    const encoded = new TextEncoder().encode(value)
    const digest = await subtle.digest("SHA-256", encoded)
    const bytes = new Uint8Array(digest)
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  } catch {
    return ""
  }
}

async function resolveRenewAssetIdForCard(card: ChatCardAttachmentPayload): Promise<string> {
  const meta = readCardAssetMeta(card)
  const source = (card.image?.original || card.url || "").trim()

  const directAssetId = pickPreferredLocalGeneratedImageAssetId([
    meta.asset_id,
    meta.assetId,
    inferGeneratedImageAssetId(source),
    inferGeneratedImageAssetId(meta.rawUrl),
  ])
  if (isLocalRenewableImageAssetId(directAssetId)) {
    return directAssetId
  }

  // Gateway renew API requires local image_<sha256("image\\n" + raw_url)> ids.
  if (meta.rawUrl) {
    const digest = await sha256Hex(`image\n${meta.rawUrl}`)
    if (digest) {
      return `image_${digest}`
    }
  }

  return directAssetId
}

async function normalizeGeneratedImageCardsInReasoningEvents(
  events: ChatReasoningEventDetail[] | undefined,
  hydrate: (
    cards: ChatCardAttachmentPayload[],
    sharedRenewCache?: Map<string, Promise<RenewedAssetUrlPayload | null>>
  ) => Promise<void>,
  sharedRenewCache?: Map<string, Promise<RenewedAssetUrlPayload | null>>
): Promise<ChatReasoningEventDetail[] | undefined> {
  if (!Array.isArray(events) || events.length === 0) {
    return events
  }

  const indexes: number[] = []
  const cards: ChatCardAttachmentPayload[] = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event || event.kind !== "card_attachment") {
      continue
    }
    indexes.push(index)
    cards.push(cloneCardAttachmentPayload(event.card))
  }
  if (cards.length === 0) {
    return events
  }

  await hydrate(cards, sharedRenewCache)

  let changed = false
  const nextEvents = events.slice()
  for (let cursor = 0; cursor < indexes.length; cursor += 1) {
    const eventIndex = indexes[cursor]
    const current = events[eventIndex]
    const nextCard = cards[cursor]
    if (!current || current.kind !== "card_attachment" || !nextCard) {
      continue
    }
    if (JSON.stringify(current.card) !== JSON.stringify(nextCard)) {
      changed = true
      nextEvents[eventIndex] = {
        ...current,
        card: nextCard,
      }
    }
  }

  return changed ? nextEvents : events
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

function coerceToolMetaCard(value: unknown): ChatCardAttachmentPayload | null {
  if (!isRecord(value)) {
    return null
  }
  const id = readTrimmedString(value.id)
  if (!id) {
    return null
  }
  const image = isRecord(value.image)
    ? {
        thumbnail: readTrimmedString(value.image.thumbnail) || undefined,
        original: readTrimmedString(value.image.original) || undefined,
        title: readTrimmedString(value.image.title) || undefined,
        link: readTrimmedString(value.image.link) || undefined,
        source: readTrimmedString(value.image.source) || undefined,
      }
    : undefined

  const baseCard: ChatCardAttachmentPayload = {
    id,
    cardType: readTrimmedString(value.cardType) || undefined,
    type: readTrimmedString(value.type) || undefined,
    url: readTrimmedString(value.url) || undefined,
    image,
  }
  return withCardAssetMeta(baseCard, {
    assetId: readCardUpstreamAssetId(value) || undefined,
    asset_id: readCardLocalAssetId(value) || undefined,
    rawUrl: readCardRawUrl(value) || undefined,
    urlExpiresAt: readCardUrlExpiresAt(value) || undefined,
  })
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
    const list = await this.repository.listMessages(conversationId)
    const refreshed = await this.refreshExpiredAssetUrlsInMessages(list)
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

  private async renewAssetUrl(assetId: string): Promise<RenewedAssetUrlPayload | null> {
    const normalizedAssetId = assetId.trim()
    if (!normalizedAssetId) {
      return null
    }
    const gatewayBaseUrl = normalizeGatewayBaseUrl(this.apiUrl)
    const renewUrl = `${gatewayBaseUrl}/assets/${encodeURIComponent(normalizedAssetId)}/url?ttl=${ASSET_URL_RENEW_TTL_SECONDS}`

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

  private async refreshExpiredAssetUrlsInMessages(messages: ChatMessage[]): Promise<{
    messages: ChatMessage[]
    updated: ChatMessage[]
  }> {
    const refreshed: ChatMessage[] = []
    const updated: ChatMessage[] = []
    const renewCache = new Map<string, Promise<RenewedAssetUrlPayload | null>>()

    for (const message of messages) {
      if (message.role !== "assistant" || !message.content.includes("<tool-meta>")) {
        refreshed.push(message)
        continue
      }

      const regex = /<tool-meta>([\s\S]*?)<\/tool-meta>/gi
      const matches = Array.from(message.content.matchAll(regex))
      if (matches.length === 0) {
        refreshed.push(message)
        continue
      }

      let nextContent = message.content
      let offset = 0
      let changed = false
      const replacementByUrl = new Map<string, string>()
      const renewedCardsById = new Map<string, ChatCardAttachmentPayload>()
      const ensuredMarkdownImageUrls = new Set<string>()

      for (const match of matches) {
        const fullBlock = match[0]
        const payloadText = match[1]?.trim() || ""
        if (!payloadText || typeof match.index !== "number") {
          continue
        }
        let payload: unknown
        try {
          payload = JSON.parse(payloadText) as unknown
        } catch {
          continue
        }
        if (!isRecord(payload) || !Array.isArray(payload.cards)) {
          continue
        }

        const cards = payload.cards.map((item) => coerceToolMetaCard(item)).filter((item): item is ChatCardAttachmentPayload => Boolean(item))
        if (cards.length === 0) {
          continue
        }

        const payloadCardsBefore = cards.map((card) => cloneCardAttachmentPayload(card))
        const restoredCards = appendMissingCardsFromReasoningEvents(cards, message.reasoningEvents)
        for (const restoredCard of restoredCards) {
          if ((restoredCard.type || "").toLowerCase() !== "generated_image") {
            continue
          }
          const restoredUrl = (restoredCard.image?.original || restoredCard.url || "").trim()
          if (!/^https?:\/\//i.test(restoredUrl)) {
            continue
          }
          ensuredMarkdownImageUrls.add(restoredUrl)
        }

        const cardsBeforeHydration = cards.map((card) => cloneCardAttachmentPayload(card))
        await this.hydrateGeneratedImageCards(cards, renewCache)
        for (const imageUrl of collectGeneratedImageUrls(cards)) {
          ensuredMarkdownImageUrls.add(imageUrl)
        }

        const payloadChanged = JSON.stringify(payloadCardsBefore) !== JSON.stringify(cards)
        if (!payloadChanged) {
          continue
        }

        const replacements = collectCardUrlReplacements(cardsBeforeHydration, cards)
        for (const [from, to] of replacements.entries()) {
          replacementByUrl.set(from, to)
        }
        for (const card of cards) {
          const id = (card.id || "").trim()
          if (!id) {
            continue
          }
          renewedCardsById.set(id, card)
        }

        payload.cards = cards
        const nextBlock = `<tool-meta>${JSON.stringify(payload)}</tool-meta>`
        const start = match.index + offset
        const end = start + fullBlock.length
        nextContent = `${nextContent.slice(0, start)}${nextBlock}${nextContent.slice(end)}`
        offset += nextBlock.length - fullBlock.length
        changed = true
      }

      const mergedReasoningEvents = mergeRenewedCardsIntoReasoningEvents(
        message.reasoningEvents,
        renewedCardsById
      )
      const normalizedReasoningEvents = await normalizeGeneratedImageCardsInReasoningEvents(
        mergedReasoningEvents,
        (cards, sharedRenewCache) => this.hydrateGeneratedImageCards(cards, sharedRenewCache),
        renewCache
      )
      const reasoningChanged =
        JSON.stringify(message.reasoningEvents || []) !== JSON.stringify(normalizedReasoningEvents || [])

      if (!changed && !reasoningChanged) {
        refreshed.push(message)
        continue
      }

      const replacedContent = changed
        ? applyUrlReplacementsOutsideToolMeta(nextContent, replacementByUrl)
        : message.content
      const nextVisibleContent = changed
        ? appendMissingGeneratedImageMarkdownOutsideToolMeta(
            replacedContent,
            ensuredMarkdownImageUrls
          )
        : replacedContent

      const nextMessage = {
        ...message,
        content: nextVisibleContent,
        reasoningEvents: normalizedReasoningEvents,
      }
      refreshed.push(nextMessage)
      updated.push(nextMessage)
    }

    return {
      messages: refreshed,
      updated,
    }
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
    const regenerateTargetResponseId = input.regenerateTargetResponseId?.trim() || ""
    const isRegenerate = regenerateTargetResponseId.length > 0
    const isDeepSearch = !isRegenerate && input.deepSearch === true
    if (!isRegenerate) {
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
      const previousResponseId = input.anchors.lastResponseId?.trim() || ""
      const requestBodyPayload: Record<string, unknown> = {
        model: input.model,
        session_id: sessionId,
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
        if (isDeepSearch) {
          requestBodyPayload["x_grok"] = {
            deep_search: true,
          }
        }
      }
      const requestBody = JSON.stringify(requestBodyPayload)

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
      while (true) {
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
          emitFailed(`http_${response.status}`, errorText || `HTTP ${response.status}`)
          return
        }

        if (!response.body) {
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
              reject(new StreamIdleTimeoutError(STREAM_IDLE_TIMEOUT_MS))
            }, STREAM_IDLE_TIMEOUT_MS)
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
              emitDelta(chunkDelta, gatewayResponseId)
            }
          }
          break
        } catch (error) {
          const shouldRetryFromIdleTimeout =
            error instanceof StreamIdleTimeoutError &&
            idleRetryAttempts < STREAM_IDLE_RETRY_MAX_ATTEMPTS &&
            !assistantText.trim() &&
            !gatewayFinalMessage.trim() &&
            collectedReasoningEvents.length === 0 &&
            !hasStructuredGeneratedImages &&
            !hasModeratedGeneratedImages
          if (shouldRetryFromIdleTimeout) {
            idleRetryAttempts += 1
            await waitForRetryDelay(STREAM_IDLE_RETRY_DELAY_MS, signal)
            continue
          }
          throw error
        } finally {
          reader.releaseLock()
        }
      }

      const renewCache = new Map<string, Promise<RenewedAssetUrlPayload | null>>()
      await this.hydrateGeneratedImageCards(collectedCards, renewCache)
      const normalizedReasoningEvents = await normalizeGeneratedImageCardsInReasoningEvents(
        collectedReasoningEvents,
        (cards, sharedRenewCache) => this.hydrateGeneratedImageCards(cards, sharedRenewCache),
        renewCache
      )

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
      const finalDurationSeconds = Math.max(1, Math.round((Date.now() - streamStartedAt) / 1000))
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

      emitCompleted({
          assistantMessage,
          anchors,
        }, assistantMessage.responseId)
    } catch (error) {
      if (error instanceof StreamIdleTimeoutError) {
        emitFailed("stream_idle_timeout", error.message, gatewayResponseId)
        return
      }
      const message = error instanceof Error ? error.message : "unknown_error"
      emitFailed("chat_stream_error", message)
    }
  }
}
