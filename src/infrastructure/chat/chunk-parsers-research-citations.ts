import type {
  ChatCardAttachmentPayload,
  ChatCitationCard,
  ChatInlineCitation,
} from "../../domain/chat/types"
import { isRecord, readOptionalString } from "./chunk-parsers-common"

function extractAttrValue(rawAttrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}="([^"]+)"`, "i")
  const matched = rawAttrs.match(pattern)?.[1]
  if (!matched) {
    return undefined
  }
  const trimmed = matched.trim()
  return trimmed || undefined
}

function extractArgumentValue(body: string, name: string): string | undefined {
  const pattern = new RegExp(`<argument\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/argument>`, "i")
  const matched = body.match(pattern)?.[1]
  if (!matched) {
    return undefined
  }
  const trimmed = matched.trim()
  return trimmed || undefined
}

export function parseCitationCards(value: unknown): ChatCitationCard[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ChatCitationCard[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const cardId =
      readOptionalString(item.card_id) ||
      readOptionalString(item.cardId) ||
      readOptionalString(item.id) ||
      ""
    if (!cardId) {
      continue
    }
    rows.push({
      cardId,
      cardType: readOptionalString(item.card_type) || readOptionalString(item.cardType),
      url: readOptionalString(item.url),
    })
  }
  return rows
}

export function parseInlineCitations(value: unknown): ChatInlineCitation[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ChatInlineCitation[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const cardId =
      readOptionalString(item.card_id) ||
      readOptionalString(item.cardId) ||
      readOptionalString(item.id) ||
      ""
    if (!cardId) {
      continue
    }
    rows.push({
      cardId,
      citationId: readOptionalString(item.citation_id) || readOptionalString(item.citationId),
      url: readOptionalString(item.url),
    })
  }
  return rows
}

export function toCitationCardFromAttachment(card: ChatCardAttachmentPayload): ChatCitationCard | null {
  const cardType = (card.cardType || card.type || "").trim()
  if (!cardType.toLowerCase().includes("citation")) {
    return null
  }
  const cardId = (card.id || "").trim()
  if (!cardId) {
    return null
  }
  const resolvedUrl = readOptionalString(card.url) || readOptionalString(card.image?.link)
  return {
    cardId,
    cardType: cardType || undefined,
    url: resolvedUrl,
  }
}

export function extractInlineCitationsFromText(value: string): ChatInlineCitation[] {
  const source = value.trim()
  if (!source) {
    return []
  }

  const rows: ChatInlineCitation[] = []
  const seen = new Set<string>()
  const renderPattern =
    /<grok:render\b([^>]*?)>([\s\S]*?)<\/grok:render>|<grok:render\b([^>]*?)\/>/gi
  let matched: RegExpExecArray | null = renderPattern.exec(source)
  while (matched) {
    const attrs = matched[1] || matched[3] || ""
    const body = matched[2] || ""
    const cardType = (extractAttrValue(attrs, "card_type") || extractAttrValue(attrs, "cardType") || "").toLowerCase()
    if (!cardType.includes("citation")) {
      matched = renderPattern.exec(source)
      continue
    }
    const cardId = extractAttrValue(attrs, "card_id") || extractAttrValue(attrs, "cardId") || ""
    if (!cardId) {
      matched = renderPattern.exec(source)
      continue
    }
    const citationId =
      extractArgumentValue(body, "citation_id") ||
      extractArgumentValue(body, "citationId") ||
      extractAttrValue(attrs, "citation_id") ||
      extractAttrValue(attrs, "citationId")
    const url =
      extractArgumentValue(body, "url") || extractAttrValue(attrs, "url")
    const key = `${cardId}\u0000${citationId || ""}\u0000${url || ""}`
    if (!seen.has(key)) {
      seen.add(key)
      rows.push({
        cardId,
        citationId: citationId || undefined,
        url: url || undefined,
      })
    }
    matched = renderPattern.exec(source)
  }

  return rows
}

