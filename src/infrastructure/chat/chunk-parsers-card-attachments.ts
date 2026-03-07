import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import {
  collectRawChunkCandidates,
  isRecord,
  parseRecords,
  readOptionalString,
} from "./chunk-parsers-common"

// ---------------------------------------------------------------------------
// Card attachments
// ---------------------------------------------------------------------------

function readOptionalExpiresAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000
    const iso = new Date(millis).toISOString()
    return iso === "Invalid Date" ? undefined : iso
  }
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number.parseFloat(trimmed)
    if (!Number.isFinite(parsed)) {
      return undefined
    }
    const millis = parsed > 1_000_000_000_000 ? parsed : parsed * 1000
    const iso = new Date(millis).toISOString()
    return iso === "Invalid Date" ? undefined : iso
  }
  const millis = Date.parse(trimmed)
  if (!Number.isFinite(millis)) {
    return undefined
  }
  return new Date(millis).toISOString()
}

function isLocalGeneratedImageAssetId(value: string): boolean {
  return /^image_[0-9a-f]{64}$/i.test(value.trim())
}

function readGeneratedImageUpstreamAssetId(value: Record<string, unknown>): string | undefined {
  return readOptionalString(value.assetId) || readOptionalString(value.imageId) || readOptionalString(value.image_id)
}

function readGeneratedImageLocalAssetId(value: Record<string, unknown>): string | undefined {
  const candidates = [
    readOptionalString(value.asset_id),
    readOptionalString(value.assetId),
    readOptionalString(value.imageId),
    readOptionalString(value.image_id),
  ]
  for (const candidate of candidates) {
    const normalized = (candidate || "").trim()
    if (isLocalGeneratedImageAssetId(normalized)) {
      return normalized
    }
  }
  return undefined
}

function readGeneratedImageModeratedFlag(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return value.moderated === true || value.rRated === true || value.r_rated === true
}

type GeneratedImageAttachment = {
  url: string
  assetId?: string
  asset_id?: string
  rawUrl?: string
  urlExpiresAt?: string
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim())
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function isIntermediateGeneratedImageUrl(url: string): boolean {
  return /-part-\d+(?=\/|$)/i.test(url)
}

function readGeneratedImageAttachment(value: unknown): GeneratedImageAttachment | null {
  if (typeof value === "string") {
    const url = value.trim()
    if (!url || isIntermediateGeneratedImageUrl(url)) {
      return null
    }
    return { url }
  }
  if (!isRecord(value)) {
    return null
  }
  const url = readOptionalString(value.url) || readOptionalString(value.imageUrl) || readOptionalString(value.image_url)
  if (!url) {
    return null
  }
  const assetId = readGeneratedImageUpstreamAssetId(value)
  const asset_id = readGeneratedImageLocalAssetId(value)
  const moderated = value.moderated === true
  const rrated = value.rRated === true || value.r_rated === true
  if (moderated || rrated) {
    return null
  }

  const progress = toOptionalNumber(value.progress)
  const isStreamingImageGeneration =
    "streamingImageGenerationResponse" in value ||
    "imageId" in value ||
    "image_id" in value ||
    "imageIndex" in value ||
    "image_index" in value ||
    "progress" in value ||
    "seq" in value

  // Match Grok behavior: ignore intermediate "-part-*" images and keep only final outputs.
  if (isIntermediateGeneratedImageUrl(url)) {
    return null
  }
  if (isStreamingImageGeneration && typeof progress === "number" && progress < 100) {
    return null
  }

  return {
    url,
    assetId,
    asset_id,
    rawUrl: readOptionalString(value.rawUrl) || readOptionalString(value.raw_url),
    urlExpiresAt: readOptionalExpiresAt(value.urlExpiresAt) || readOptionalExpiresAt(value.url_expires_at),
  }
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: string[] = []
  for (const item of value) {
    const normalized = readOptionalString(item)
    if (normalized) {
      rows.push(normalized)
    } else {
      rows.push("")
    }
  }
  return rows
}

function readExpiresList(value: unknown): Array<string | undefined> {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: Array<string | undefined> = []
  for (const item of value) {
    rows.push(readOptionalExpiresAt(item))
  }
  return rows
}

function collectGeneratedImageAttachmentsFromIndexedArrays(value: Record<string, unknown>): GeneratedImageAttachment[] {
  const urls = readStringList(value.generatedImageUrls)
  if (urls.length === 0) {
    return []
  }
  const rawUrlsPrimary = readStringList(value.generatedImageRawUrls)
  const rawUrlsFallback = readStringList(value.generatedImageRawURLs)
  const rawUrls = rawUrlsPrimary.length > 0 ? rawUrlsPrimary : rawUrlsFallback
  const assetIdsPrimary = readStringList(value.generatedImageAssetIds)
  const assetIdsFallback = readStringList(value.generatedImageAssetIDs)
  const assetIds = assetIdsPrimary.length > 0 ? assetIdsPrimary : assetIdsFallback
  const expiresAtPrimary = readExpiresList(value.generatedImageURLExpiresAt)
  const expiresAtFallback = readExpiresList(value.generatedImageUrlExpiresAt)
  const expiresAt = expiresAtPrimary.length > 0 ? expiresAtPrimary : expiresAtFallback

  const items: GeneratedImageAttachment[] = []
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]?.trim() || ""
    if (!url || isIntermediateGeneratedImageUrl(url)) {
      continue
    }
    items.push({
      url,
      rawUrl: rawUrls[index]?.trim() || undefined,
      asset_id: assetIds[index]?.trim() || undefined,
      urlExpiresAt: expiresAt[index],
    })
  }
  return items
}

function generatedImageAttachmentScore(item: GeneratedImageAttachment): number {
  let score = 0
  if (item.asset_id) {
    score += 2
  }
  if (item.assetId) {
    score += 1
  }
  if (item.rawUrl) {
    score += 1
  }
  if (item.urlExpiresAt) {
    score += 1
  }
  return score
}

function buildGeneratedImageCard(payload: GeneratedImageAttachment): ChatCardAttachmentPayload {
  const { url, assetId, asset_id, rawUrl, urlExpiresAt } = payload
  const stableId = `generated_image_${encodeURIComponent(url)}`
  return {
    id: stableId,
    cardType: "image_card",
    type: "generated_image",
    url,
    assetId,
    asset_id,
    rawUrl,
    urlExpiresAt,
    image: {
      original: url,
    },
  }
}

function collectGeneratedImageAttachmentsFromEnvelope(value: Record<string, unknown>): GeneratedImageAttachment[] {
  const byUrl = new Map<string, GeneratedImageAttachment>()
  const append = (item: GeneratedImageAttachment | null) => {
    if (!item) {
      return
    }
    const key = item.url.trim()
    if (!key) {
      return
    }
    const existing = byUrl.get(key)
    if (!existing) {
      byUrl.set(key, item)
      return
    }
    if (generatedImageAttachmentScore(item) > generatedImageAttachmentScore(existing)) {
      byUrl.set(key, item)
    }
  }

  const streamingImageGeneration = isRecord(value.streamingImageGenerationResponse)
    ? value.streamingImageGenerationResponse
    : null
  if (streamingImageGeneration) {
    append(readGeneratedImageAttachment(streamingImageGeneration))
  }

  if (Array.isArray(value.generatedImageUrls)) {
    for (const item of value.generatedImageUrls) {
      append(readGeneratedImageAttachment(item))
    }
  }
  for (const item of collectGeneratedImageAttachmentsFromIndexedArrays(value)) {
    append(item)
  }

  const modelResponse = isRecord(value.modelResponse) ? value.modelResponse : null
  if (modelResponse && Array.isArray(modelResponse.generatedImageUrls)) {
    for (const item of modelResponse.generatedImageUrls) {
      append(readGeneratedImageAttachment(item))
    }
  }
  if (modelResponse) {
    for (const item of collectGeneratedImageAttachmentsFromIndexedArrays(modelResponse)) {
      append(item)
    }
  }

  return Array.from(byUrl.values())
}

export function extractGeneratedImageModeratedFromRawChunk(rawChunk: unknown): boolean {
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return false
  }

  for (const candidate of candidates) {
    if (readGeneratedImageModeratedFlag(candidate)) {
      return true
    }

    const streamingImageGeneration = isRecord(candidate.streamingImageGenerationResponse)
      ? candidate.streamingImageGenerationResponse
      : null
    if (streamingImageGeneration && readGeneratedImageModeratedFlag(streamingImageGeneration)) {
      return true
    }

    const arraysToCheck: unknown[][] = []
    if (Array.isArray(candidate.generatedImageUrls)) {
      arraysToCheck.push(candidate.generatedImageUrls)
    }
    if (Array.isArray(candidate.data)) {
      arraysToCheck.push(candidate.data)
    }
    if (isRecord(candidate.image_generation) && Array.isArray(candidate.image_generation.data)) {
      arraysToCheck.push(candidate.image_generation.data)
    }
    if (isRecord(candidate.modelResponse) && Array.isArray(candidate.modelResponse.generatedImageUrls)) {
      arraysToCheck.push(candidate.modelResponse.generatedImageUrls)
    }
    for (const list of arraysToCheck) {
      for (const item of list) {
        if (readGeneratedImageModeratedFlag(item)) {
          return true
        }
      }
    }
  }

  return false
}

function parseCardAttachmentRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value) && typeof value.jsonData === "string") {
    return parseRecords(value.jsonData)[0] ?? null
  }
  return parseRecords(value)[0] ?? null
}

type CardAttachmentParseOptions = {
  dropGeneratedImageCard?: boolean
}

function readCardAttachmentPayload(
  value: unknown,
  options: CardAttachmentParseOptions = {}
): ChatCardAttachmentPayload | null {
  const parsed = parseCardAttachmentRecord(value)
  if (!parsed) {
    return null
  }

  const image = isRecord(parsed.image) ? parsed.image : null
  const directUrl = typeof parsed.url === "string" ? parsed.url.trim() : ""
  const imageOriginal = image && typeof image.original === "string" ? image.original.trim() : ""
  const imageThumbnail = image && typeof image.thumbnail === "string" ? image.thumbnail.trim() : ""
  const stableUrl = imageOriginal || directUrl || imageThumbnail
  const normalizedType = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : ""
  const isGeneratedImageCard =
    normalizedType === "generated_image" ||
    normalizedType.includes("generated_image") ||
    /(?:^|\/)generated\//i.test(stableUrl) ||
    /\/assets\/image\//i.test(stableUrl)
  if (isGeneratedImageCard && options.dropGeneratedImageCard) {
    return null
  }
  if (isGeneratedImageCard) {
    if (isIntermediateGeneratedImageUrl(stableUrl)) {
      return null
    }
    const progress = toOptionalNumber(parsed.progress) ?? (image ? toOptionalNumber(image.progress) : null)
    if (typeof progress === "number" && progress < 100) {
      return null
    }
    if (readGeneratedImageModeratedFlag(parsed) || (image && readGeneratedImageModeratedFlag(image))) {
      return null
    }
  }
  const idRaw = typeof parsed.id === "string" ? parsed.id.trim() : ""
  const id = idRaw || (stableUrl ? `image_card_${encodeURIComponent(stableUrl)}` : "")
  if (!id) {
    return null
  }

  return {
    id,
    cardType: typeof parsed.cardType === "string" ? parsed.cardType : undefined,
    type: typeof parsed.type === "string" ? parsed.type : undefined,
    url: directUrl || undefined,
    assetId: readGeneratedImageUpstreamAssetId(parsed),
    asset_id: readGeneratedImageLocalAssetId(parsed),
    rawUrl: readOptionalString(parsed.rawUrl) || readOptionalString(parsed.raw_url),
    urlExpiresAt: readOptionalExpiresAt(parsed.urlExpiresAt) || readOptionalExpiresAt(parsed.url_expires_at),
    image: image
      ? {
          thumbnail: typeof image.thumbnail === "string" ? image.thumbnail : undefined,
          original: typeof image.original === "string" ? image.original : undefined,
          title: typeof image.title === "string" ? image.title : undefined,
          link: typeof image.link === "string" ? image.link : undefined,
          source: typeof image.source === "string" ? image.source : undefined,
        }
      : undefined,
  }
}

function collectCardAttachmentsFromUnknownList(
  value: unknown,
  options: CardAttachmentParseOptions = {}
): ChatCardAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []
  for (const item of value) {
    const card = readCardAttachmentPayload(item, options)
    if (card) {
      cards.push(card)
    }
  }
  return cards
}

function collectCardAttachmentsFromEnvelope(
  value: unknown,
  options: CardAttachmentParseOptions = {}
): ChatCardAttachmentPayload[] {
  if (!isRecord(value)) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []

  const imageGeneration = isRecord(value.image_generation) ? value.image_generation : null
  const imageGenerationData = imageGeneration && Array.isArray(imageGeneration.data) ? imageGeneration.data : []
  for (const item of imageGenerationData) {
    const generated = readGeneratedImageAttachment(item)
    if (generated) {
      if (!options.dropGeneratedImageCard) {
        cards.push(buildGeneratedImageCard(generated))
      }
    }
  }

  const responseData = Array.isArray(value.data) ? value.data : []
  for (const item of responseData) {
    const generated = readGeneratedImageAttachment(item)
    if (generated) {
      if (!options.dropGeneratedImageCard) {
        cards.push(buildGeneratedImageCard(generated))
      }
    }
  }

  for (const generated of collectGeneratedImageAttachmentsFromEnvelope(value)) {
    if (!options.dropGeneratedImageCard) {
      cards.push(buildGeneratedImageCard(generated))
    }
  }

  const inlineCard = readCardAttachmentPayload(value.cardAttachment, options)
  if (inlineCard) {
    cards.push(inlineCard)
  }

  const inlineCardParsed = readCardAttachmentPayload(value.cardAttachmentParsed, options)
  if (inlineCardParsed) {
    cards.push(inlineCardParsed)
  }

  for (const card of collectCardAttachmentsFromUnknownList(value.cardAttachmentsJson, options)) {
    cards.push(card)
  }

  for (const card of collectCardAttachmentsFromUnknownList(value.cardAttachments, options)) {
    cards.push(card)
  }

  return cards
}

export function extractCardAttachmentsFromRawChunk(rawChunk: unknown): ChatCardAttachmentPayload[] {
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const eventType = typeof candidate.type === "string" ? candidate.type.trim() : ""
    const dropGeneratedImageCard = eventType === "response.output_item.added"
    for (const card of collectCardAttachmentsFromEnvelope(candidate, { dropGeneratedImageCard })) {
      if (seen.has(card.id)) {
        continue
      }
      seen.add(card.id)
      cards.push(card)
    }
  }

  return cards
}
