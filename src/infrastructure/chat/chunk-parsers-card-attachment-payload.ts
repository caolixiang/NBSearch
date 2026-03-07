import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import { isRecord, parseRecords, readOptionalString } from "./chunk-parsers-common"
import {
  buildGeneratedImageCard,
  collectGeneratedImageAttachmentsFromEnvelope,
  isIntermediateGeneratedImageUrl,
  readGeneratedImageAttachment,
  readGeneratedImageLocalAssetId,
  readGeneratedImageModeratedFlag,
  readGeneratedImageUpstreamAssetId,
  readOptionalExpiresAt,
} from "./chunk-parsers-generated-image-attachments"

function parseCardAttachmentRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value) && typeof value.jsonData === "string") {
    return parseRecords(value.jsonData)[0] ?? null
  }
  return parseRecords(value)[0] ?? null
}

export type CardAttachmentParseOptions = {
  dropGeneratedImageCard?: boolean
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

export function readCardAttachmentPayload(
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

export function collectCardAttachmentsFromEnvelope(
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
    if (generated && !options.dropGeneratedImageCard) {
      cards.push(buildGeneratedImageCard(generated))
    }
  }

  const responseData = Array.isArray(value.data) ? value.data : []
  for (const item of responseData) {
    const generated = readGeneratedImageAttachment(item)
    if (generated && !options.dropGeneratedImageCard) {
      cards.push(buildGeneratedImageCard(generated))
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
