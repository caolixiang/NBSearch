import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import type { RenewedAssetUrlCache } from "./gateway-media-workflows"
import {
  type RenewedAssetUrlPayload,
  parseRenewedAssetUrlResponse,
  readCardAssetMeta,
  resolveRenewAssetIdForCard,
  shouldRenewCardAssetUrl,
  withCardAssetMeta,
  withCardAssetMetadata,
} from "./gateway-media-assets"

const ASSET_URL_RENEW_TTL_SECONDS = 7200

export async function renewGeneratedAssetUrlFromGateway(input: {
  gatewayBaseUrl: string
  runtimeFetch: typeof fetch
  createAuthHeaders: (extra?: Record<string, string>) => Record<string, string>
  assetId: string
  ttlSeconds?: number
}): Promise<RenewedAssetUrlPayload | null> {
  const normalizedAssetId = input.assetId.trim()
  if (!normalizedAssetId) {
    return null
  }

  const ttlSeconds = input.ttlSeconds ?? ASSET_URL_RENEW_TTL_SECONDS
  const renewUrl = `${input.gatewayBaseUrl}/assets/${encodeURIComponent(normalizedAssetId)}/url?ttl=${ttlSeconds}`

  try {
    const response = await input.runtimeFetch(renewUrl, {
      method: "GET",
      headers: input.createAuthHeaders(),
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

export async function hydrateGeneratedImageCardsFromGateway(input: {
  cards: ChatCardAttachmentPayload[]
  gatewayBaseUrl: string
  runtimeFetch: typeof fetch
  createAuthHeaders: (extra?: Record<string, string>) => Record<string, string>
  sharedRenewCache?: RenewedAssetUrlCache
  ttlSeconds?: number
}): Promise<void> {
  if (input.cards.length === 0) {
    return
  }

  const renewCache = input.sharedRenewCache || new Map<string, Promise<RenewedAssetUrlPayload | null>>()
  const renewOnce = (assetId: string): Promise<RenewedAssetUrlPayload | null> => {
    const normalizedAssetId = assetId.trim()
    if (!normalizedAssetId) {
      return Promise.resolve(null)
    }
    const existing = renewCache.get(normalizedAssetId)
    if (existing) {
      return existing
    }
    const next = renewGeneratedAssetUrlFromGateway({
      gatewayBaseUrl: input.gatewayBaseUrl,
      runtimeFetch: input.runtimeFetch,
      createAuthHeaders: input.createAuthHeaders,
      assetId: normalizedAssetId,
      ttlSeconds: input.ttlSeconds,
    })
    renewCache.set(normalizedAssetId, next)
    return next
  }

  await Promise.all(
    input.cards.map(async (item, index) => {
      if ((item.type || "").toLowerCase() !== "generated_image") {
        return
      }
      const current = input.cards[index]
      const renewAssetId = await resolveRenewAssetIdForCard(current)
      if (!renewAssetId) {
        return
      }
      const currentMeta = readCardAssetMeta(current)
      if (currentMeta.asset_id !== renewAssetId) {
        input.cards[index] = withCardAssetMeta(current, {
          asset_id: renewAssetId,
        })
      }
      if (!shouldRenewCardAssetUrl(input.cards[index])) {
        return
      }

      const renewed = await renewOnce(renewAssetId)
      if (!renewed) {
        return
      }
      input.cards[index] = withCardAssetMetadata(input.cards[index], renewed)
    })
  )
}
