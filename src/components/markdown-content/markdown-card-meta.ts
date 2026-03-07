import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "@/domain/chat/types"
import type { ImageCardMeta } from "./types"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/[\[\]\\]/g, "\\$&").replace(/\n+/g, " ").trim()
}

export function wrapMarkdownUrl(url: string): string {
  return url.trim().replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function toImageCardMeta(card: ChatCardAttachmentPayload): ImageCardMeta | null {
  const id = typeof card.id === "string" ? card.id.trim() : ""
  if (!id) {
    return null
  }
  const raw = card as unknown as Record<string, unknown>

  const topLevelThumbnail = typeof raw.thumbnail === "string" ? raw.thumbnail : undefined
  const topLevelOriginal = typeof raw.original === "string" ? raw.original : undefined
  const topLevelTitle = typeof raw.title === "string" ? raw.title : undefined
  const topLevelLink = typeof raw.link === "string" ? raw.link : undefined
  const topLevelSource = typeof raw.source === "string" ? raw.source : undefined
  const topLevelAssetId =
    typeof raw.assetId === "string"
      ? raw.assetId
      : typeof raw.asset_id === "string"
        ? raw.asset_id
        : undefined
  const topLevelRawUrl =
    typeof raw.rawUrl === "string"
      ? raw.rawUrl
      : typeof raw.raw_url === "string"
        ? raw.raw_url
        : undefined
  const topLevelUrlExpiresAt =
    typeof raw.urlExpiresAt === "string"
      ? raw.urlExpiresAt
      : typeof raw.url_expires_at === "string"
        ? raw.url_expires_at
        : undefined

  return {
    id,
    cardType: card.cardType,
    type: card.type,
    url: card.url,
    assetId: card.assetId || topLevelAssetId,
    rawUrl: card.rawUrl || topLevelRawUrl,
    urlExpiresAt: card.urlExpiresAt || topLevelUrlExpiresAt,
    image: card.image
      ? {
          thumbnail: card.image.thumbnail,
          original: card.image.original,
          title: card.image.title,
          link: card.image.link,
          source: card.image.source,
        }
      : undefined,
    thumbnail: topLevelThumbnail,
    original: topLevelOriginal,
    title: topLevelTitle,
    link: topLevelLink,
    source: topLevelSource,
  }
}

export function collectCardsFromReasoningEvents(events: ChatReasoningEventDetail[]): Record<string, ImageCardMeta> {
  const cards: Record<string, ImageCardMeta> = {}

  for (const detail of events) {
    if (detail.kind !== "card_attachment") {
      continue
    }
    const meta = toImageCardMeta(detail.card)
    if (!meta) {
      continue
    }
    cards[meta.id] = meta
  }

  return cards
}
