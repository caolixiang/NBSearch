import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "../../domain/chat/types"
import { isRecord, parseJsonObjectStrings } from "./chunk-parsers"

const ASSET_URL_RENEW_THRESHOLD_MS = 60 * 1000

export type RenewedAssetUrlPayload = {
  assetId: string
  rawUrl: string
  url: string
  urlExpiresAt: string
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

export function normalizeCardAttachmentUrls(card: ChatCardAttachmentPayload, apiUrl: string): ChatCardAttachmentPayload {
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

export function readCardAssetMeta(card: ChatCardAttachmentPayload): {
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

export function withCardAssetMeta(
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

export function withCardAssetMetadata(
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

export function collectCardUrlReplacements(
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

export function applyUrlReplacementsOutsideToolMeta(content: string, replacements: Map<string, string>): string {
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

export function cloneCardAttachmentPayload(card: ChatCardAttachmentPayload): ChatCardAttachmentPayload {
  return {
    ...card,
    image: card.image ? { ...card.image } : undefined,
  }
}

export function appendMissingCardsFromReasoningEvents(
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

export function appendMissingGeneratedImageMarkdownOutsideToolMeta(content: string, urls: Set<string>): string {
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

function parseGeneratedImageMarkdownUrl(line: string): string {
  const match = line.trim().match(/^!\[Generated Image\]\(<(https?:\/\/[^>]+)>\)$/i)
  return match?.[1]?.trim() || ""
}

export function pruneGeneratedImageMarkdownOutsideToolMeta(content: string, allowedUrls: Set<string>): string {
  if (!content || allowedUrls.size === 0) {
    return content
  }

  const segments = content.split(/(<tool-meta>[\s\S]*?<\/tool-meta>)/gi)
  const keptUrls = new Set<string>()

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] || ""
    if (!segment || /^<tool-meta>[\s\S]*<\/tool-meta>$/i.test(segment)) {
      continue
    }

    const lines = segment.split("\n")
    const nextLines: string[] = []
    for (const line of lines) {
      const imageUrl = parseGeneratedImageMarkdownUrl(line)
      if (!imageUrl) {
        nextLines.push(line)
        continue
      }
      if (!allowedUrls.has(imageUrl) || keptUrls.has(imageUrl)) {
        continue
      }
      keptUrls.add(imageUrl)
      nextLines.push(line)
    }
    segments[index] = nextLines.join("\n")
  }

  return segments.join("")
}

export function collectGeneratedImageUrls(cards: ChatCardAttachmentPayload[]): Set<string> {
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

export function mergeRenewedCardsIntoReasoningEvents(
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

export function isGeneratedImageNarration(text: string): boolean {
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

function isLikelyDecodedImagePath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return true
  }
  return trimmed.startsWith("/") || trimmed.startsWith("users/")
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
      if (decoded && isLikelyDecodedImagePath(decoded)) {
        return decoded
      }
    }
    if (encoded.startsWith("u_")) {
      const decoded = decodeBase64Url(encoded.slice(2))
      if (decoded && isLikelyDecodedImagePath(decoded)) {
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

export function canonicalizeGeneratedImagePath(raw: string): { key: string; isPart: boolean } {
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

export function preferGeneratedCardByUrlQuality(
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

function collectGeneratedImageIdentityKeys(card: ChatCardAttachmentPayload): string[] {
  if ((card.type || "").toLowerCase() !== "generated_image") {
    return []
  }

  const keys = new Set<string>()
  const addCanonical = (value: string) => {
    const canonical = canonicalizeGeneratedImagePath(value).key
    if (!canonical) {
      return
    }
    keys.add(`canonical:${canonical.toLowerCase()}`)
  }
  const addLocalAsset = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized || !isLocalRenewableImageAssetId(normalized)) {
      return
    }
    keys.add(`local:${normalized}`)
  }
  const addUpstreamAsset = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized || isLocalRenewableImageAssetId(normalized)) {
      return
    }
    keys.add(`upstream:${normalized}`)
  }

  const source = (card.image?.original || card.url || "").trim()
  const meta = readCardAssetMeta(card)
  const inferredFromSource = inferGeneratedImageAssetId(source)
  const inferredFromRawUrl = inferGeneratedImageAssetId(meta.rawUrl)

  addCanonical(source)
  addCanonical(meta.rawUrl)

  addLocalAsset(meta.asset_id)
  addLocalAsset(inferredFromSource)
  addLocalAsset(inferredFromRawUrl)

  addUpstreamAsset(meta.assetId)
  addUpstreamAsset(inferredFromSource)
  addUpstreamAsset(inferredFromRawUrl)

  return Array.from(keys)
}

export function dedupeGeneratedImageCards(
  cards: ChatCardAttachmentPayload[],
  apiUrl: string
): ChatCardAttachmentPayload[] {
  if (cards.length <= 1) {
    return cards
  }

  const deduped: ChatCardAttachmentPayload[] = []
  const indexByIdentity = new Map<string, number>()
  const reserveIdentities = (identities: string[], index: number) => {
    for (const key of identities) {
      if (!key) {
        continue
      }
      indexByIdentity.set(key, index)
    }
  }

  for (const card of cards) {
    if ((card.type || "").toLowerCase() !== "generated_image") {
      deduped.push(card)
      continue
    }

    const identities = collectGeneratedImageIdentityKeys(card)
    let matchedIndex = -1
    for (const key of identities) {
      const index = indexByIdentity.get(key)
      if (typeof index === "number") {
        matchedIndex = index
        break
      }
    }

    if (matchedIndex < 0) {
      deduped.push(card)
      reserveIdentities(identities, deduped.length - 1)
      continue
    }

    const existing = deduped[matchedIndex] || card
    const preferred = preferGeneratedCardByUrlQuality(existing, card, apiUrl)
    deduped[matchedIndex] = preferred
    reserveIdentities(identities, matchedIndex)
    reserveIdentities(collectGeneratedImageIdentityKeys(preferred), matchedIndex)
  }

  return deduped
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

export function isLocalRenewableImageAssetId(value: string): boolean {
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

export async function resolveRenewAssetIdForCard(card: ChatCardAttachmentPayload): Promise<string> {
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

export async function normalizeGeneratedImageCardsInReasoningEvents(
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

export function extractGeneratedImageMarkdown(cards: ChatCardAttachmentPayload[]): string {
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

export function coerceToolMetaCard(value: unknown): ChatCardAttachmentPayload | null {
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