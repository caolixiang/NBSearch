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

  const isRenderableImageCard = (card: ImageCardMeta | undefined): boolean => {
    if (!card) {
      return false
    }
    const cardType = (card.cardType || "").toLowerCase()
    const type = (card.type || "").toLowerCase()
    if (cardType === "image_card" || type.includes("image")) {
      return true
    }

    const original = normalizeCardImageUrl(card.image?.original || card.original || "")
    const thumbnail = normalizeCardImageUrl(card.image?.thumbnail || card.thumbnail || "")
    return Boolean(original || thumbnail)
  }

  const toMarkdownImageFromCard = (card: ImageCardMeta | undefined): string => {
    if (!isRenderableImageCard(card)) {
      return ""
    }
    const resolved = card as ImageCardMeta
    const originalImageUrl = normalizeCardImageUrl(resolved.image?.original || resolved.original || "")
    const thumbnailImageUrl = normalizeCardImageUrl(resolved.image?.thumbnail || resolved.thumbnail || "")
    const sourceLinkUrl = normalizeCardTargetUrl(resolved.image?.link || resolved.link || "")
    const cardLinkUrl = normalizeCardTargetUrl(resolved.url || "")

    let imageUrl = originalImageUrl || thumbnailImageUrl
    if (!imageUrl) {
      return ""
    }

    // Embed the thumbnail as a fallback if original is provided.
    // We base64 encode it so it doesn't break URL parsing.
    if (imageUrl === originalImageUrl && thumbnailImageUrl && thumbnailImageUrl !== originalImageUrl) {
      imageUrl = `${imageUrl}#fallback=${encodeURIComponent(thumbnailImageUrl)}`
    }

    const targetUrl =
      sourceLinkUrl ||
      cardLinkUrl ||
      normalizeCardTargetUrl(originalImageUrl) ||
      normalizeCardTargetUrl(thumbnailImageUrl)

    const alt = escapeMarkdownText(resolved.image?.title || resolved.title || resolved.image?.source || resolved.source || "Generated Image") || "Generated Image"
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
  const expandedWithFallbackHints = injectFallbackHintsFromCards(expanded, cards)

  const hasMarkdownImage = /!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)/.test(expandedWithFallbackHints)
  if (hasMarkdownImage) {
    return expandedWithFallbackHints
  }

  const fallbackImageLines = Object.values(cards)
    .map((card) => toMarkdownImageFromCard(card))
    .filter((line) => line.trim().length > 0)

  if (fallbackImageLines.length === 0) {
    return expandedWithFallbackHints
  }
  if (!expandedWithFallbackHints.trim()) {
    return fallbackImageLines.join("\n")
  }
  return `${expandedWithFallbackHints.trim()}\n\n${fallbackImageLines.join("\n")}`
}

function isImageMarkdownLine(line: string): boolean {
  const value = line.trim()
  if (!value) {
    return false
  }
  return (
    /^\s*!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value) ||
    /^\s*\[!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value)
  )
}

function isImageCaptionNoiseLine(line: string): boolean {
  const value = line.trim()
  if (!value) {
    return false
  }
  return /^generated image/i.test(value)
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

      if (isImageCaptionNoiseLine(line)) {
        // Upstream often inserts "Generated Image..." caption noise between image cards.
        // Skip it so consecutive images can still be merged into one gallery paragraph.
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

function isLikelyDataImageUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(text)
}

function isBlockedImagePlaceholder(value: string): boolean {
  const text = value
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, "")
  if (!text) {
    return false
  }
  return /^\[?\s*image blocked\s*[:：]/i.test(text)
}

function unwrapMarkdownUrl(value: string): string {
  const text = value.trim()
  if (text.startsWith("<") && text.endsWith(">") && text.length > 2) {
    return text.slice(1, -1).trim()
  }
  return text
}

function normalizeAbsoluteHttpUrl(value: string): string {
  const raw = unwrapMarkdownUrl(value)
  if (!raw) {
    return ""
  }

  const candidates = [raw]
  const encoded = encodeURI(raw)
  if (encoded !== raw) {
    candidates.push(encoded)
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href
      }
    } catch {
      // Try the next candidate.
    }
  }
  return ""
}

function normalizeCardImageUrl(value: string): string {
  const text = unwrapMarkdownUrl(value)
  if (!text || isBlockedImagePlaceholder(text)) {
    return ""
  }
  if (isLikelyDataImageUrl(text)) {
    return text
  }
  return normalizeAbsoluteHttpUrl(text)
}

function normalizeCardTargetUrl(value: string): string {
  const text = unwrapMarkdownUrl(value)
  if (!text || isBlockedImagePlaceholder(text)) {
    return ""
  }
  return normalizeAbsoluteHttpUrl(text)
}

function stripFallbackSuffix(value: string): string {
  const marker = "#fallback="
  const index = value.indexOf(marker)
  if (index < 0) {
    return value
  }
  return value.slice(0, index)
}

function buildUrlMatchKeys(value: string): string[] {
  const normalized = normalizeAbsoluteHttpUrl(value)
  if (!normalized) {
    return []
  }

  const keys = new Set<string>([normalized])
  try {
    const parsed = new URL(normalized)
    const host = parsed.host.toLowerCase()
    const protocolAgnostic = `//${host}${parsed.pathname}${parsed.search}`
    keys.add(protocolAgnostic)
  } catch {
    // Ignore URL parsing errors; normalized key is already present.
  }
  return Array.from(keys)
}

function injectFallbackHintsFromCards(content: string, cards: Record<string, ImageCardMeta>): string {
  if (!content) {
    return content
  }

  const fallbackByOriginal = new Map<string, string>()
  for (const card of Object.values(cards)) {
    const original = normalizeCardImageUrl(card.image?.original || card.original || "")
    const thumbnail = normalizeCardImageUrl(card.image?.thumbnail || card.thumbnail || "")
    if (!original || !thumbnail || original === thumbnail) {
      continue
    }
    const originalKeyBase = normalizeAbsoluteHttpUrl(stripFallbackSuffix(original))
    if (!originalKeyBase) {
      continue
    }
    for (const key of buildUrlMatchKeys(originalKeyBase)) {
      if (!fallbackByOriginal.has(key)) {
        fallbackByOriginal.set(key, thumbnail)
      }
    }
  }

  if (fallbackByOriginal.size === 0) {
    return content
  }

  return content.replace(/!\[((?:\\.|[^\]])*)\]\((<[^>]+>|[^)\n]+)\)/g, (raw, alt, srcRaw) => {
    const srcText = String(srcRaw || "").trim()
    const hadAngleWrapper = srcText.startsWith("<") && srcText.endsWith(">")
    const normalizedSrc = normalizeCardImageUrl(srcText)
    if (!normalizedSrc) {
      return raw
    }

    const withoutFallback = normalizeAbsoluteHttpUrl(stripFallbackSuffix(normalizedSrc))
    if (!withoutFallback) {
      return raw
    }
    const fallback =
      buildUrlMatchKeys(withoutFallback)
        .map((key) => fallbackByOriginal.get(key))
        .find((value): value is string => Boolean(value)) || ""
    if (!fallback) {
      return raw
    }
    if (normalizedSrc.includes("#fallback=")) {
      return raw
    }

    const nextSrc = `${withoutFallback}#fallback=${encodeURIComponent(fallback)}`
    const rewrittenSrc = hadAngleWrapper ? `<${nextSrc}>` : wrapMarkdownUrl(nextSrc)
    return `![${alt}](${rewrittenSrc})`
  })
}

function extractFirstImageUrlFromText(value: string): string {
  const match = /https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[<>\s"]*)?/i.exec(value)
  return match?.[0] || ""
}

function normalizeRenderableImageUrl(value: string): string {
  const text = unwrapMarkdownUrl(value)
  if (!text) {
    return ""
  }
  return normalizeAbsoluteHttpUrl(text)
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

function isStandaloneImageMarkdown(value: string): boolean {
  return (
    /^\s*!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value) ||
    /^\s*\[!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value)
  )
}

function hasMarkdownImage(value: string): boolean {
  return /\[!\[(?:\\.|[^\]])*]\((?:<[^>\n]+>|[^)\n]+)\)\]\((?:<[^>\n]+>|[^)\n]+)\)|!\[(?:\\.|[^\]])*]\((?:<[^>\n]+>|[^)\n]+)\)/.test(value)
}

function splitInlineImageMarkdownParagraphs(content: string): string {
  if (!content) {
    return ""
  }

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
    if (insideFence || !trimmed) {
      next.push(line)
      continue
    }
    if (!hasMarkdownImage(line)) {
      next.push(line)
      continue
    }

    const imageTokens: string[] = []
    const textChunks: string[] = []
    const tokenMatcher =
      /\[!\[(?:\\.|[^\]])*]\((?:<[^>\n]+>|[^)\n]+)\)\]\((?:<[^>\n]+>|[^)\n]+)\)|!\[(?:\\.|[^\]])*]\((?:<[^>\n]+>|[^)\n]+)\)/g
    let cursor = 0
    let match: RegExpExecArray | null = tokenMatcher.exec(line)
    while (match) {
      const start = match.index
      const end = start + match[0].length
      const between = line.slice(cursor, start).trim()
      if (between) {
        textChunks.push(between)
      }
      const token = match[0].trim()
      if (token) {
        imageTokens.push(token)
      }
      cursor = end
      match = tokenMatcher.exec(line)
    }

    const trailing = line.slice(cursor).trim()
    if (trailing) {
      textChunks.push(trailing)
    }

    if (imageTokens.length === 0) {
      next.push(line)
      continue
    }

    const paragraphText = textChunks.join(" ").replace(/\s{2,}/g, " ").trim()
    if (paragraphText) {
      // Keep images in a dedicated markdown paragraph so gallery detection can
      // reliably identify image-only <p> blocks.
      next.push(paragraphText)
      next.push("")
    }
    next.push(imageTokens.join(" "))
    if (paragraphText) {
      next.push("")
    }
  }

  return next.join("\n")
}

function rewriteToolJsonLine(line: string): ToolJsonLineRewrite {
  const trimmed = line.trim()

  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    // Keep markdown image lines intact; they may contain URLs with extensions.
    if (isStandaloneImageMarkdown(trimmed)) {
      return {
        kind: "keep",
        line,
      }
    }
    // Avoid re-extracting URLs from mixed text/image markdown lines.
    // Upstream frequently emits sentences immediately followed by [![...](img)](source).
    if (hasMarkdownImage(trimmed)) {
      return {
        kind: "keep",
        line,
      }
    }

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
  normalized = splitInlineImageMarkdownParagraphs(normalized)
  normalized = mergeConsecutiveImageLines(normalized)
  normalized = normalized.replace(/([^\n])(?=\s#{1,6}\s)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^[\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/(^|\n)(#{1,6}\s[^\n-]+)-\s?/g, "$1$2\n- ")
  // Remove upstream "[Image blocked: ...]" text which Grok inserts when it refuses an image,
  // since we render the card attachments anyway.
  normalized = normalized.replace(/\[Image blocked:[^\]]*\](?:\([^)]*\))?/gi, "")
  // Removed the aggressive Chinese hyphen replacement. 
  // It incorrectly matched city names like '米兰-科尔蒂纳' (Milan-Cortina) and broke markdown formatting.
  // Keep bold/italic numeric titles like "**1. 标题**" intact.
  normalized = normalized.replace(/([^\n*_])(?=\d+\.\s)/g, "$1\n")
  // --- Image markdown repair ---
  // Step 1: Unwrap single-line linked images: [![alt](img)](link) → ![alt](img)
  normalized = normalized.replace(
    /\[(!\[(?:\\.|[^\]])*]\([^)]+\))\]\([^)]+\)/g,
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
    /(!\[(?:\\.|[^\]])*]\()(https?:\/\/[^)]+)(\))/g,
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
