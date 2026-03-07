import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "../../domain/chat/types"
import {
  cloneCardAttachmentPayload,
  isLocalRenewableImageAssetId,
  readCardAssetMeta,
} from "./gateway-media-asset-meta"
import type { RenewedAssetUrlPayload } from "./gateway-media-renewal"

function parseGeneratedImageMarkdownUrl(line: string): string {
  const match = line.trim().match(/^!\[Generated Image\]\(<(https?:\/\/[^>]+)>\)$/i)
  return match?.[1]?.trim() || ""
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

export function canonicalizeGeneratedImagePath(raw: string): { key: string; isPart: boolean } {
  const sourcePath = resolveGeneratedImageSourcePath(raw)
  if (!sourcePath) {
    return { key: "", isPart: false }
  }
  const isPart = /-part-\d+(?=\/|$)/i.test(sourcePath)
  const key = sourcePath.replace(/-part-\d+(?=\/|$)/gi, "")
  return { key, isPart }
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
