import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import { isRecord, readOptionalString } from "./chunk-parsers-common"

export function readOptionalExpiresAt(value: unknown): string | undefined {
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

export function readGeneratedImageUpstreamAssetId(value: Record<string, unknown>): string | undefined {
  return readOptionalString(value.assetId) || readOptionalString(value.imageId) || readOptionalString(value.image_id)
}

export function readGeneratedImageLocalAssetId(value: Record<string, unknown>): string | undefined {
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

export function readGeneratedImageModeratedFlag(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return value.moderated === true || value.rRated === true || value.r_rated === true
}

export type GeneratedImageAttachment = {
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

export function isIntermediateGeneratedImageUrl(url: string): boolean {
  return /-part-\d+(?=\/|$)/i.test(url)
}

export function readGeneratedImageAttachment(value: unknown): GeneratedImageAttachment | null {
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

export function buildGeneratedImageCard(payload: GeneratedImageAttachment): ChatCardAttachmentPayload {
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

export function collectGeneratedImageAttachmentsFromEnvelope(
  value: Record<string, unknown>
): GeneratedImageAttachment[] {
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
