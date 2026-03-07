import type { AssistantToolMeta, ImageCardMeta } from "./types"
import { isRecord } from "./markdown-card-meta"

export function extractAssistantToolMeta(raw: string): { content: string; meta: AssistantToolMeta } {
  const meta: AssistantToolMeta = { webSearch: [], cards: {} }
  if (!raw) {
    return { content: "", meta }
  }

  const matches = Array.from(raw.matchAll(/<tool-meta>([\s\S]*?)<\/tool-meta>/gi))
  for (const match of matches) {
    const payload = match[1]?.trim()
    if (!payload) {
      continue
    }
    try {
      const parsed = JSON.parse(payload) as { webSearch?: unknown; cards?: unknown }
      if (Array.isArray(parsed.webSearch)) {
        for (const item of parsed.webSearch) {
          if (!item || typeof item !== "object") {
            continue
          }
          const row = item as { query?: unknown; numResults?: unknown }
          const query = typeof row.query === "string" ? row.query.trim() : ""
          const numResults =
            typeof row.numResults === "number"
              ? row.numResults
              : typeof row.numResults === "string"
                ? Number.parseInt(row.numResults, 10)
                : NaN
          if (!query || !Number.isFinite(numResults) || numResults <= 0) {
            continue
          }
          meta.webSearch.push({ query, numResults })
        }
      }

      if (Array.isArray(parsed.cards)) {
        for (const item of parsed.cards) {
          if (!item || typeof item !== "object") {
            continue
          }
          const row = item as ImageCardMeta
          const rowRecord = item as Record<string, unknown>
          const id = typeof row.id === "string" ? row.id.trim() : ""
          if (!id) {
            continue
          }
          meta.cards[id] = {
            id,
            cardType: typeof row.cardType === "string" ? row.cardType : undefined,
            type: typeof row.type === "string" ? row.type : undefined,
            url: typeof row.url === "string" ? row.url : undefined,
            assetId:
              typeof row.assetId === "string"
                ? row.assetId
                : typeof rowRecord.asset_id === "string"
                  ? rowRecord.asset_id
                  : undefined,
            rawUrl:
              typeof row.rawUrl === "string"
                ? row.rawUrl
                : typeof rowRecord.raw_url === "string"
                  ? rowRecord.raw_url
                  : undefined,
            urlExpiresAt:
              typeof row.urlExpiresAt === "string"
                ? row.urlExpiresAt
                : typeof rowRecord.url_expires_at === "string"
                  ? rowRecord.url_expires_at
                  : undefined,
            image:
              row.image && isRecord(row.image)
                ? {
                    thumbnail: typeof row.image.thumbnail === "string" ? row.image.thumbnail : undefined,
                    original: typeof row.image.original === "string" ? row.image.original : undefined,
                    title: typeof row.image.title === "string" ? row.image.title : undefined,
                    link: typeof row.image.link === "string" ? row.image.link : undefined,
                    source: typeof row.image.source === "string" ? row.image.source : undefined,
                  }
                : undefined,
          }
        }
      }
    } catch {
      continue
    }
  }

  return {
    content: raw.replace(/<tool-meta>[\s\S]*?<\/tool-meta>/gi, "").trim(),
    meta,
  }
}
