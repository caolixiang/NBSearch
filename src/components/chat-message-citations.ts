import type {
  ChatDeepSearchResearch,
  ChatInlineCitation,
  ChatReasoningEventDetail,
} from "@/domain/chat/types"

type CitationRenderItem = {
  key: string
  url: string
  label: string
}

type ParsedTailCitation = {
  url: string
  label: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function shouldHidePdfExportForGeneratedContent(content: string): boolean {
  if (!content || !content.includes("<tool-meta>")) {
    return false
  }

  const matches = content.matchAll(/<tool-meta>([\s\S]*?)<\/tool-meta>/gi)
  let sawGeneratedCard = false
  let sawNonGeneratedCard = false

  for (const match of matches) {
    const payloadText = (match[1] || "").trim()
    if (!payloadText) {
      continue
    }

    let payload: unknown
    try {
      payload = JSON.parse(payloadText) as unknown
    } catch {
      continue
    }
    if (!isRecord(payload) || !Array.isArray(payload.cards)) {
      continue
    }

    for (const card of payload.cards) {
      if (!isRecord(card)) {
        continue
      }
      const cardType = typeof card.type === "string" ? card.type.trim().toLowerCase() : ""
      if (!cardType) {
        continue
      }
      if (cardType === "generated_image" || cardType.includes("generated_image")) {
        sawGeneratedCard = true
        continue
      }
      sawNonGeneratedCard = true
    }
  }

  return sawGeneratedCard && !sawNonGeneratedCard
}

export function resolveSourceCount(events: ChatReasoningEventDetail[] | undefined): number {
  if (!events || events.length === 0) {
    return 0
  }

  const countByCardId = new Map<string, number>()
  let totalWithoutCardId = 0

  for (const detail of events) {
    if (detail.kind !== "tool_result") {
      continue
    }

    const webSearchResults = Array.isArray(detail.result.webSearchResults) ? detail.result.webSearchResults : []
    const fromRows = webSearchResults.length
    const fromCount =
      typeof detail.result.webSearchResultsCount === "number" && Number.isFinite(detail.result.webSearchResultsCount)
        ? Math.max(0, Math.floor(detail.result.webSearchResultsCount))
        : 0
    const count = Math.max(fromRows, fromCount)
    if (count <= 0) {
      continue
    }

    const cardId = (detail.result.toolUsageCardId || "").trim()
    if (!cardId) {
      totalWithoutCardId += count
      continue
    }
    countByCardId.set(cardId, Math.max(countByCardId.get(cardId) || 0, count))
  }

  let total = totalWithoutCardId
  for (const count of countByCardId.values()) {
    total += count
  }
  return total
}

function normalizeCitationUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return ""
    }
    return parsed.href
  } catch {
    return ""
  }
}

function fallbackCitationLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./, "")
    const path = parsed.pathname === "/" ? "" : parsed.pathname
    const short = `${host}${path}`
    if (short.length <= 84) {
      return short
    }
    return `${short.slice(0, 81)}...`
  } catch {
    return url
  }
}

function cleanCitationLabel(input: string): string {
  return input
    .replace(/^[\s\-–—:：;；,.，。]+/, "")
    .replace(/[\s\-–—:：;；,.，。]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isKeyCitationsHeading(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[*_`~\s]+|[*_`~\s]+$/g, "")
    .replace(/[：:]\s*$/, "")
    .trim()
    .toLowerCase()
  return normalized === "key citations" || normalized === "key citation"
}

function parseTailCitationLine(line: string): ParsedTailCitation | null {
  const body = line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .trim()
  if (!body) {
    return null
  }

  const markdownLinkMatch = body.match(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/i)
  if (markdownLinkMatch) {
    const url = markdownLinkMatch[2] || ""
    const labelFromLink = cleanCitationLabel(markdownLinkMatch[1] || "")
    const labelFromLine = cleanCitationLabel(body.replace(markdownLinkMatch[0], ""))
    return {
      url,
      label: labelFromLink || labelFromLine,
    }
  }

  const parenthesizedUrlMatch = body.match(/[（(]\s*(https?:\/\/[^)\s]+)\s*[）)]/i)
  if (parenthesizedUrlMatch) {
    const url = parenthesizedUrlMatch[1] || ""
    return {
      url,
      label: cleanCitationLabel(body.replace(parenthesizedUrlMatch[0], "")),
    }
  }

  const bareUrlMatch = body.match(/https?:\/\/\S+/i)
  if (bareUrlMatch) {
    const rawUrl = bareUrlMatch[0] || ""
    const sanitizedUrl = rawUrl.replace(/[)>）.,，。;；!！?？]+$/g, "")
    return {
      url: sanitizedUrl,
      label: cleanCitationLabel(body.replace(rawUrl, "")),
    }
  }

  return null
}

export function extractTrailingKeyCitationEntries(content: string): ParsedTailCitation[] {
  if (!content) {
    return []
  }

  const sanitizedContent = content.replace(/<tool-meta>[\s\S]*?<\/tool-meta>/gi, "")
  const lines = sanitizedContent.split(/\r?\n/)
  let headingIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isKeyCitationsHeading(lines[index] || "")) {
      headingIndex = index
      break
    }
  }
  if (headingIndex < 0) {
    return []
  }

  const tailLines = lines.slice(headingIndex + 1)
  if (tailLines.length === 0 || !tailLines.some((line) => /https?:\/\//i.test(line))) {
    return []
  }

  const entries: ParsedTailCitation[] = []
  let pendingLabel = ""

  for (const line of tailLines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const parsed = parseTailCitationLine(trimmed)
    if (parsed) {
      const normalizedUrl = normalizeCitationUrl(parsed.url)
      if (!normalizedUrl) {
        pendingLabel = ""
        continue
      }
      const candidateLabel = cleanCitationLabel(parsed.label || pendingLabel)
      entries.push({
        url: normalizedUrl,
        label: candidateLabel || fallbackCitationLabel(normalizedUrl),
      })
      pendingLabel = ""
      continue
    }

    const plainText = cleanCitationLabel(trimmed.replace(/^[-*+]\s+/, ""))
    if (plainText) {
      pendingLabel = pendingLabel ? `${pendingLabel} ${plainText}` : plainText
    }
  }

  return entries
}

function collectCitationTitleByUrl(events: ChatReasoningEventDetail[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!events || events.length === 0) {
    return map
  }
  for (const detail of events) {
    if (detail.kind !== "tool_result" || !Array.isArray(detail.result.webSearchResults)) {
      continue
    }
    for (const row of detail.result.webSearchResults) {
      const normalizedUrl = normalizeCitationUrl(row.url || "")
      if (!normalizedUrl) {
        continue
      }
      const title = (row.title || "").trim()
      if (!title || map.has(normalizedUrl)) {
        continue
      }
      map.set(normalizedUrl, title)
    }
  }
  return map
}

export function buildCitationItems(
  research: ChatDeepSearchResearch | undefined,
  events: ChatReasoningEventDetail[] | undefined,
  rawContent: string | undefined
): CitationRenderItem[] {
  const inlineRows = Array.isArray(research?.inlineCitations) ? research.inlineCitations : []

  const citationCardUrlById = new Map<string, string>()
  for (const row of research?.citationCards || []) {
    const cardId = row.cardId.trim()
    if (!cardId) {
      continue
    }
    const normalizedUrl = normalizeCitationUrl(row.url || "")
    if (!normalizedUrl || citationCardUrlById.has(cardId)) {
      continue
    }
    citationCardUrlById.set(cardId, normalizedUrl)
  }

  const titleByUrl = collectCitationTitleByUrl(events)
  const rows: CitationRenderItem[] = []
  const seenInlineKeys = new Set<string>()
  const seenUrls = new Set<string>()

  const append = (entry: ChatInlineCitation) => {
    const directUrl = normalizeCitationUrl(entry.url || "")
    const mappedUrl = directUrl || citationCardUrlById.get(entry.cardId) || ""
    if (!mappedUrl) {
      return
    }
    const key = `${entry.cardId}\u0000${entry.citationId || ""}`
    if (seenInlineKeys.has(key)) {
      return
    }
    seenInlineKeys.add(key)
    seenUrls.add(mappedUrl)
    const label = titleByUrl.get(mappedUrl) || fallbackCitationLabel(mappedUrl)
    rows.push({
      key,
      url: mappedUrl,
      label,
    })
  }

  for (const row of inlineRows) {
    append(row)
  }

  const tailEntries = extractTrailingKeyCitationEntries(rawContent || "")
  for (let index = 0; index < tailEntries.length; index += 1) {
    const entry = tailEntries[index]
    if (!entry || seenUrls.has(entry.url)) {
      continue
    }
    seenUrls.add(entry.url)
    rows.push({
      key: `tail\u0000${index}\u0000${entry.url}`,
      url: entry.url,
      label: entry.label || titleByUrl.get(entry.url) || fallbackCitationLabel(entry.url),
    })
  }

  return rows
}
