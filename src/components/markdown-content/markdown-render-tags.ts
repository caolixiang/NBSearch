import type { ImageCardMeta } from "./types"
import { escapeMarkdownText, wrapMarkdownUrl } from "./markdown-card-meta"
import {
  buildUrlMatchKeys,
  normalizeAbsoluteHttpUrl,
  normalizeCardImageUrl,
  normalizeCardTargetUrl,
  stripFallbackSuffix,
} from "./markdown-link-utils"

function extractAttrValue(rawAttrs: string, name: string): string {
  const match = rawAttrs.match(new RegExp(`${name}="([^"]+)"`, "i"))?.[1]
  return (match || "").trim()
}

function buildCitationPillLabel(url: string): string {
  const normalized = normalizeCardTargetUrl(url)
  if (!normalized) {
    return ""
  }
  try {
    return new URL(normalized).host.replace(/^www\./i, "")
  } catch {
    return ""
  }
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
    if (!fallback || normalizedSrc.includes("#fallback=")) {
      return raw
    }

    const nextSrc = `${withoutFallback}#fallback=${encodeURIComponent(fallback)}`
    const rewrittenSrc = hadAngleWrapper ? `<${nextSrc}>` : wrapMarkdownUrl(nextSrc)
    return `![${alt}](${rewrittenSrc})`
  })
}

export function expandGrokRenderTags(content: string, cards: Record<string, ImageCardMeta>): string {
  const hasContent = content.trim().length > 0
  const source = hasContent ? content : ""
  const lastThinkStart = source.lastIndexOf("<think")
  const lastThinkEnd = source.lastIndexOf("</think>")
  const hasOpenThink = lastThinkStart >= 0 && lastThinkEnd < lastThinkStart

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

    if (imageUrl === originalImageUrl && thumbnailImageUrl && thumbnailImageUrl !== originalImageUrl) {
      imageUrl = `${imageUrl}#fallback=${encodeURIComponent(thumbnailImageUrl)}`
    }

    const targetUrl =
      sourceLinkUrl ||
      cardLinkUrl ||
      normalizeCardTargetUrl(originalImageUrl) ||
      normalizeCardTargetUrl(thumbnailImageUrl)

    const alt =
      escapeMarkdownText(
        resolved.image?.title || resolved.title || resolved.image?.source || resolved.source || "Generated Image"
      ) || "Generated Image"
    const imageMarkdown = `![${alt}](${wrapMarkdownUrl(imageUrl)})`
    return targetUrl ? `[${imageMarkdown}](${wrapMarkdownUrl(targetUrl)})` : imageMarkdown
  }

  let previousCitationUrl = ""
  let previousCitationEnd = -1
  let previousRenderedCitation = false

  const replaceRenderTag = (raw: string, rawAttrs: string, offset: number, fullSource: string): string => {
    const normalizedCardId = extractAttrValue(rawAttrs, "card_id") || extractAttrValue(rawAttrs, "cardId")
    const card = normalizedCardId ? cards[normalizedCardId] : undefined
    const cardType = (card?.cardType || extractAttrValue(rawAttrs, "card_type") || extractAttrValue(rawAttrs, "cardType")).toLowerCase()

    if (cardType.includes("citation")) {
      const citationUrl = normalizeCardTargetUrl(card?.url || card?.image?.link || "")
      const citationLabel = buildCitationPillLabel(citationUrl)
      const previousChar = offset > 0 ? fullSource.slice(offset - 1, offset) : ""
      const shouldPrefixSpace =
        previousRenderedCitation ||
        (!!previousChar && !/\s/.test(previousChar))
      previousRenderedCitation = false

      if (!citationUrl || !citationLabel) {
        previousCitationUrl = ""
        previousCitationEnd = -1
        return ""
      }
      const betweenPreviousCitationAndCurrent =
        previousCitationEnd >= 0 ? fullSource.slice(previousCitationEnd, offset) : ""
      if (previousCitationUrl === citationUrl && !betweenPreviousCitationAndCurrent.trim()) {
        return ""
      }

      previousCitationUrl = citationUrl
      previousCitationEnd = offset + raw.length
      previousRenderedCitation = true
      return `${shouldPrefixSpace ? " " : ""}[${escapeMarkdownText(citationLabel)}](${wrapMarkdownUrl(citationUrl)})`
    }

    previousCitationUrl = ""
    previousCitationEnd = -1
    previousRenderedCitation = false
    return toMarkdownImageFromCard(card)
  }

  const expanded = source.replace(
    /<grok:render\b([^>]*?)(?:>[\s\S]*?<\/grok:render>|\/>)/gi,
    (raw, rawAttrs, offset, fullSource) => replaceRenderTag(raw, rawAttrs || "", offset, fullSource)
  )
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
