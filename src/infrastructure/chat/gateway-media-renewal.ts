import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import { isRecord, parseJsonObjectStrings } from "./chunk-parsers"
import {
  normalizeExpiresAtValue,
  readCardAssetMeta,
  readCardLocalAssetId,
  readCardRawUrl,
  readCardUrlExpiresAt,
  readTrimmedString,
  withCardAssetMeta,
} from "./gateway-media-asset-meta"

const ASSET_URL_RENEW_THRESHOLD_MS = 60 * 1000

export type RenewedAssetUrlPayload = {
  assetId: string
  rawUrl: string
  url: string
  urlExpiresAt: string
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
    const explicitExpiresAt =
      normalizeExpiresAtValue(candidate.url_expires_at) || normalizeExpiresAtValue(candidate.urlExpiresAt)
    const inferredExpiresAt = inferExpiresAtFromSignedUrl(url)
    const urlExpiresAt = explicitExpiresAt || inferredExpiresAt
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
