import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "@/domain/chat/types"
import type { AssistantToolMeta, ImageCardMeta, ToolJsonLineRewrite } from "./types"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/[[\]\\]/g, "\\$&").replace(/\n+/g, " ").trim()
}

export function wrapMarkdownUrl(url: string): string {
  // Avoid angle-bracket wrapping — causes issues in nested [![alt](src)](href) syntax
  return url.trim().replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function toImageCardMeta(card: ChatCardAttachmentPayload): ImageCardMeta | null {
  const id = typeof card.id === "string" ? card.id.trim() : ""
  if (!id) {
    return null
  }

  return {
    id,
    cardType: card.cardType,
    type: card.type,
    url: card.url,
    image: card.image
      ? {
          thumbnail: card.image.thumbnail,
          original: card.image.original,
          title: card.image.title,
          link: card.image.link,
          source: card.image.source,
        }
      : undefined,
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

export function expandGrokRenderTags(content: string, cards: Record<string, ImageCardMeta>): string {
  const hasContent = content.trim().length > 0
  const source = hasContent ? content : ""
  const lastThinkStart = source.lastIndexOf("<think")
  const lastThinkEnd = source.lastIndexOf("</think>")
  const hasOpenThink = lastThinkStart >= 0 && lastThinkEnd < lastThinkStart

  // Match upstream chat behavior: do not show card images before think section closes.
  if (hasOpenThink) {
    return source
  }

  const toMarkdownImageFromCard = (card: ImageCardMeta | undefined): string => {
    if (!card) {
      return ""
    }
    const orig = (card.image?.original || "").trim()
    const thumb = (card.image?.thumbnail || "").trim()
    const fallbackLink = (card.image?.link || "").trim()
    const cUrl = (card.url || "").trim()

    const targetUrl = orig || fallbackLink || cUrl || thumb
    let imageUrl = orig || cUrl || thumb
    if (!imageUrl) {
      return ""
    }

    // Embed the thumbnail as a fallback if original is provided.
    // We base64 encode it so it doesn't break URL parsing.
    if (imageUrl === orig && thumb && thumb !== orig) {
      imageUrl = `${imageUrl}#fallback=${encodeURIComponent(thumb)}`
    }

    const alt = escapeMarkdownText(card.image?.title || card.image?.source || "Generated Image") || "Generated Image"
    const imageMarkdown = `![${alt}](${wrapMarkdownUrl(imageUrl)})`
    return targetUrl ? `[${imageMarkdown}](${wrapMarkdownUrl(targetUrl)})` : imageMarkdown
  }

  const replaceRenderTag = (_raw: string, cardId: string): string => {
    const normalizedCardId = typeof cardId === "string" ? cardId.trim() : ""
    const card = normalizedCardId ? cards[normalizedCardId] : undefined
    return toMarkdownImageFromCard(card)
  }

  const withPairTags = source.replace(
    /<grok:render\b[^>]*card_id="([^"]+)"[^>]*>[\s\S]*?<\/grok:render>/gi,
    replaceRenderTag
  )
  const expanded = withPairTags.replace(/<grok:render\b[^>]*card_id="([^"]+)"[^>]*\/>/gi, replaceRenderTag)

  const hasMarkdownImage = /!\[[^\]]*]\((?:<[^>]+>|[^)]+)\)/.test(expanded)
  if (hasMarkdownImage) {
    return expanded
  }

  const fallbackImageLines = Object.values(cards)
    .map((card) => toMarkdownImageFromCard(card))
    .filter((line) => line.trim().length > 0)

  if (fallbackImageLines.length === 0) {
    return expanded
  }
  if (!expanded.trim()) {
    return fallbackImageLines.join("\n")
  }
  return `${expanded.trim()}\n\n${fallbackImageLines.join("\n")}`
}

function isImageMarkdownLine(line: string): boolean {
  const value = line.trim()
  if (!value) {
    return false
  }
  return (
    /^\s*!\[[^\]]*]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value) ||
    /^\s*\[!\[[^\]]*]\((?:<[^>]+>|[^)]+)\)]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value)
  )
}

function mergeConsecutiveImageLines(content: string): string {
  const lines = content.split("\n")
  const merged: string[] = []
  let index = 0

  while (index < lines.length) {
    const currentLine = lines[index]?.trim() || ""
    if (!isImageMarkdownLine(currentLine)) {
      merged.push(lines[index] || "")
      index += 1
      continue
    }

    const imageLines = [currentLine]
    index += 1

    while (index < lines.length) {
      const line = lines[index]?.trim() || ""
      if (isImageMarkdownLine(line)) {
        imageLines.push(line)
        index += 1
        continue
      }

      if (line === "") {
        let lookahead = index + 1
        while (lookahead < lines.length && (lines[lookahead]?.trim() || "") === "") {
          lookahead += 1
        }
        const next = lines[lookahead]?.trim() || ""
        if (isImageMarkdownLine(next)) {
          imageLines.push(next)
          index = lookahead + 1
          continue
        }
      }
      break
    }

    merged.push(imageLines.join(" "))
    merged.push("")
  }

  while (merged.length > 0 && merged[merged.length - 1] === "") {
    merged.pop()
  }
  return merged.join("\n")
}

export function isLikelyImageUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:[?#].*)?$/i.test(text)
}

export function isLikelyHttpUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^https?:\/\/[^\s<>"']+$/i.test(text)
}

function extractFirstImageUrlFromText(value: string): string {
  const match = /https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[<>\s"]*)?/i.exec(value)
  return match?.[0] || ""
}

function normalizeRenderableImageUrl(value: string): string {
  const text = value.trim()
  if (!text || !isLikelyHttpUrl(text)) {
    return ""
  }
  return text
}

function toMarkdownImageLine(url: string): string {
  return `![Generated Image](<${normalizeRenderableImageUrl(url)}>)`
}

function extractImageUrlFromJsonLikeLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) {
    return ""
  }
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return ""
  }

  const imageUrlMatch = /["']image_url["']\s*:\s*["']([^"']+)["']/i.exec(trimmed)
  if (imageUrlMatch?.[1]) {
    return normalizeRenderableImageUrl(imageUrlMatch[1])
  }

  const urlMatch = /["']url["']\s*:\s*["']([^"']+)["']/i.exec(trimmed)
  if (urlMatch?.[1] && isLikelyImageUrl(urlMatch[1])) {
    return normalizeRenderableImageUrl(urlMatch[1])
  }

  return ""
}

function isLikelyInternalRelayJson(value: Record<string, unknown>): boolean {
  const hasRoutingKey =
    typeof value.to === "string" ||
    typeof value.from === "string" ||
    typeof value.sender === "string" ||
    typeof value.receiver === "string" ||
    typeof value.recipient === "string" ||
    typeof value.rolloutId === "string" ||
    typeof value.rollout_id === "string"

  if (!hasRoutingKey) {
    return false
  }

  return typeof value.message === "string" || typeof value.content === "string"
}

function rewriteToolJsonLine(line: string): ToolJsonLineRewrite {
  const trimmed = line.trim()

  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    if (isLikelyImageUrl(trimmed)) {
      return {
        kind: "keep",
        line: toMarkdownImageLine(trimmed),
      }
    }
    const inlineImageUrl = extractFirstImageUrlFromText(trimmed)
    if (inlineImageUrl) {
      const textWithoutImage = trimmed.replace(inlineImageUrl, "").trim()
      if (!textWithoutImage) {
        return {
          kind: "keep",
          line: toMarkdownImageLine(inlineImageUrl),
        }
      }
      return {
        kind: "keep",
        line: `${textWithoutImage}\n${toMarkdownImageLine(inlineImageUrl)}`,
      }
    }
    return {
      kind: "keep",
      line,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const looseImageUrl = extractImageUrlFromJsonLikeLine(trimmed)
    if (looseImageUrl) {
      return {
        kind: "keep",
        line: toMarkdownImageLine(looseImageUrl),
      }
    }
    return {
      kind: "keep",
      line,
    }
  }
  if (!isRecord(parsed)) {
    return {
      kind: "keep",
      line,
    }
  }

  if (isLikelyInternalRelayJson(parsed)) {
    return {
      kind: "drop",
    }
  }

  const explicitImageUrlRaw =
    typeof parsed.image_url === "string"
      ? parsed.image_url
      : typeof parsed.imageUrl === "string"
        ? parsed.imageUrl
        : ""
  const explicitImageUrl = normalizeRenderableImageUrl(explicitImageUrlRaw)
  if (explicitImageUrl) {
    return {
      kind: "keep",
      line: toMarkdownImageLine(explicitImageUrl),
    }
  }

  const toolKeys = [
    "query",
    "q",
    "num_results",
    "number_of_images",
    "image_description",
    "instructions",
    "url",
    "prompt",
    "toolUsageCardId",
  ]
  if (toolKeys.some((key) => key in parsed)) {
    return {
      kind: "drop",
    }
  }

  const urlValue = typeof parsed.url === "string" ? normalizeRenderableImageUrl(parsed.url) : ""
  if (urlValue && isLikelyImageUrl(urlValue)) {
    return {
      kind: "keep",
      line: toMarkdownImageLine(urlValue),
    }
  }

  return {
    kind: "keep",
    line,
  }
}

function rewriteImageTags(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content
  normalized = normalized.replace(
    /<image>\s*(https?:\/\/[^\s<>"')]+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[<>\s"]*)?)\s*<\/image>/gi,
    (_raw, url) => toMarkdownImageLine(url)
  )
  normalized = normalized.replace(
    /<image[^>]*\bsrc=["'](https?:\/\/[^"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[^"']*)?)["'][^>]*\/?>/gi,
    (_raw, url) => toMarkdownImageLine(url)
  )
  normalized = normalized.replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
  normalized = normalized.replace(/<image\b[^>]*\/>/gi, "")
  return normalized
}

function rewriteToolJsonLines(content: string): string {
  const lines = content.split("\n")
  const next: string[] = []
  let insideFence = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      insideFence = !insideFence
      next.push(line)
      continue
    }
    if (insideFence) {
      next.push(line)
      continue
    }

    const rewritten = rewriteToolJsonLine(line)
    if (rewritten.kind === "drop") {
      continue
    }
    next.push(rewritten.line)
  }

  return next.join("\n")
}

export function normalizeAssistantMarkdown(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content.replace(/\r\n?/g, "\n")
  normalized = normalized.replace(/<tool-meta>[\s\S]*?<\/tool-meta>/gi, "")
  normalized = normalized.replace(/<grok:render\b[\s\S]*?<\/grok:render>/gi, "")
  normalized = normalized.replace(/<grok:render\b[^>]*\/>/gi, "")
  normalized = normalized.replace(/<argument\b[\s\S]*?<\/argument>/gi, "")
  normalized = normalized.replace(/<\/think>/gi, "")
  normalized = rewriteImageTags(normalized)
  normalized = rewriteToolJsonLines(normalized)
  normalized = mergeConsecutiveImageLines(normalized)
  normalized = normalized.replace(/([^\n])(?=#{1,6}\s?)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/(^|\n)(#{1,6}\s[^\n-]+)-\s?/g, "$1$2\n- ")
  // Removed the aggressive Chinese hyphen replacement. 
  // It incorrectly matched city names like '米兰-科尔蒂纳' (Milan-Cortina) and broke markdown formatting.
  normalized = normalized.replace(/([^\n])(?=\d+\.\s)/g, "$1\n")
  // --- Image markdown repair ---
  // Step 1: Unwrap single-line linked images: [![alt](img)](link) → ![alt](img)
  normalized = normalized.replace(
    /\[(!\[[^\]]*\]\([^)]+\))\]\([^)]+\)/g,
    "$1"
  )
  // Step 2: Fix multi-line linked images: [![alt\ntext](img)](link) → ![alt text](img)
  normalized = normalized.replace(
    /\[!\[([\s\S]*?)\]\(([^)]+)\)\]\([^)]+\)/g,
    (_, alt, imgSrc) => {
      const cleanAlt = alt.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim()
      return `![${cleanAlt}](${imgSrc})`
    }
  )
  // Step 3: Fix multi-line plain images: ![alt\ntext](url) → ![alt text](url)
  normalized = normalized.replace(
    /!\[([\s\S]*?)\]\((https?:\/\/[^)]+)\)/g,
    (_, alt, url) => {
      if (!alt.includes("\n")) return `![${alt}](${url})`
      const cleanAlt = alt.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim()
      return `![${cleanAlt}](${url})`
    }
  )
  // Step 4: Fix URLs with spaces: ![alt](https://encrypted - tbn0...) → remove spaces in URL
  normalized = normalized.replace(
    /(!\[[^\]]*\]\()(https?:\/\/[^)]+)(\))/g,
    (_, prefix, url, suffix) => {
      const fixedUrl = url.replace(/\s+/g, "")
      return `${prefix}${fixedUrl}${suffix}`
    }
  )
  normalized = normalized.replace(/\n{3,}/g, "\n\n")
  return normalized.trim()
}

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
          const id = typeof row.id === "string" ? row.id.trim() : ""
          if (!id) {
            continue
          }
          meta.cards[id] = {
            id,
            cardType: typeof row.cardType === "string" ? row.cardType : undefined,
            type: typeof row.type === "string" ? row.type : undefined,
            url: typeof row.url === "string" ? row.url : undefined,
            image:
              row.image && typeof row.image === "object"
                ? {
                    thumbnail:
                      typeof row.image.thumbnail === "string" ? row.image.thumbnail : undefined,
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
