import type { ImageCardMeta } from "./types"
import { escapeMarkdownText, wrapMarkdownUrl } from "./markdown-card-meta"
import {
  buildUrlMatchKeys,
  normalizeAbsoluteHttpUrl,
  normalizeCardImageUrl,
  normalizeCardTargetUrl,
  stripFallbackSuffix,
} from "./markdown-link-utils"

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
