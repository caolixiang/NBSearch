import type { ChatCardAttachmentPayload } from "../../domain/chat/types"

export function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function normalizeExpiresAtValue(value: unknown): string {
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

export function readCardUpstreamAssetId(value: Record<string, unknown>): string {
  const upstream = readTrimmedString(value.assetId)
  if (upstream && !isLocalRenewableImageAssetId(upstream)) {
    return upstream
  }
  return ""
}

export function readCardLocalAssetId(value: Record<string, unknown>): string {
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

export function readCardRawUrl(value: Record<string, unknown>): string {
  return readTrimmedString(value.rawUrl) || readTrimmedString(value.raw_url)
}

export function readCardUrlExpiresAt(value: Record<string, unknown>): string {
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

export function cloneCardAttachmentPayload(card: ChatCardAttachmentPayload): ChatCardAttachmentPayload {
  return {
    ...card,
    image: card.image ? { ...card.image } : undefined,
  }
}

export function isLocalRenewableImageAssetId(value: string): boolean {
  return /^image_[0-9a-f]{64}$/i.test(value.trim())
}

export function coerceToolMetaCard(value: unknown): ChatCardAttachmentPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = readTrimmedString(record.id)
  if (!id) {
    return null
  }
  const imageValue = record.image
  const image =
    typeof imageValue === "object" && imageValue !== null && !Array.isArray(imageValue)
      ? {
          thumbnail: readTrimmedString((imageValue as Record<string, unknown>).thumbnail) || undefined,
          original: readTrimmedString((imageValue as Record<string, unknown>).original) || undefined,
          title: readTrimmedString((imageValue as Record<string, unknown>).title) || undefined,
          link: readTrimmedString((imageValue as Record<string, unknown>).link) || undefined,
          source: readTrimmedString((imageValue as Record<string, unknown>).source) || undefined,
        }
      : undefined

  const baseCard: ChatCardAttachmentPayload = {
    id,
    cardType: readTrimmedString(record.cardType) || undefined,
    type: readTrimmedString(record.type) || undefined,
    url: readTrimmedString(record.url) || undefined,
    image,
  }
  return withCardAssetMeta(baseCard, {
    assetId: readCardUpstreamAssetId(record) || undefined,
    asset_id: readCardLocalAssetId(record) || undefined,
    rawUrl: readCardRawUrl(record) || undefined,
    urlExpiresAt: readCardUrlExpiresAt(record) || undefined,
  })
}
