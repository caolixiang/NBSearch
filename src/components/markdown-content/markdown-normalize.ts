import type { ToolJsonLineRewrite } from "./types"
import { isRecord } from "./markdown-card-meta"
import {
  extractFirstImageUrlFromText,
  extractImageUrlFromJsonLikeLine,
  hasMarkdownImage,
  isLikelyImageUrl,
  isLikelyInternalRelayJson,
  isStandaloneImageMarkdown,
  normalizeRenderableImageUrl,
  toMarkdownImageLine,
} from "./markdown-link-utils"

export {
  isRecord,
  escapeMarkdownText,
  wrapMarkdownUrl,
  toImageCardMeta,
  collectCardsFromReasoningEvents,
} from "./markdown-card-meta"
export { expandGrokRenderTags } from "./markdown-render-tags"
export { isLikelyImageUrl, isLikelyHttpUrl } from "./markdown-link-utils"
export { extractAssistantToolMeta } from "./markdown-tool-meta"

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
    if (isStandaloneImageMarkdown(trimmed)) {
      return {
        kind: "keep",
        line,
      }
    }
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

function fixBrokenYearRanges(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content.replace(
    /([（(]\s*)(\d{4})\s*\n+\s*-\s*(\d{4})(\s*[）)])/g,
    "$1$2 - $3$4"
  )
  normalized = normalized.replace(/(\d{4})\s*\n+\s*-\s*(\d{4})(?!\d)/g, "$1 - $2")
  return normalized
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

function isCitationTailLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) {
    return true
  }
  if (/^[-*+]\s+/.test(trimmed)) {
    return true
  }
  if (/https?:\/\//i.test(trimmed)) {
    return true
  }
  if (/^[（(]\s*https?:\/\//i.test(trimmed)) {
    return true
  }
  return false
}

function stripTrailingKeyCitationsSection(content: string): string {
  if (!content) {
    return ""
  }

  const lines = content.split("\n")
  let headingIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isKeyCitationsHeading(lines[index] || "")) {
      headingIndex = index
      break
    }
  }
  if (headingIndex < 0) {
    return content
  }

  const tail = lines.slice(headingIndex + 1)
  if (tail.length === 0) {
    return lines.slice(0, headingIndex).join("\n").trimEnd()
  }

  const hasUrl = tail.some((line) => /https?:\/\//i.test(line))
  if (!hasUrl || !tail.every((line) => isCitationTailLine(line))) {
    return content
  }

  return lines.slice(0, headingIndex).join("\n").trimEnd()
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
  normalized = fixBrokenYearRanges(normalized)
  normalized = splitInlineImageMarkdownParagraphs(normalized)
  normalized = mergeConsecutiveImageLines(normalized)
  normalized = normalized.replace(/([^\n])(?=\s#{1,6}\s)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/\[Image blocked:[^\]]*](?:\([^)]*\))?/gi, "")
  normalized = normalized.replace(/([^\n*_])(?=\d+\.\s)/g, "$1\n")
  normalized = normalized.replace(/\[(!\[(?:\\.|[^\]])*]\([^)]+\))\]\([^)]+\)/g, "$1")
  normalized = normalized.replace(/\[!\[([\s\S]*?)\]\(([^)]+)\)\]\([^)]+\)/g, (_, alt, imgSrc) => {
    const cleanAlt = alt.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim()
    return `![${cleanAlt}](${imgSrc})`
  })
  normalized = normalized.replace(/!\[([\s\S]*?)\]\((https?:\/\/[^)]+)\)/g, (_, alt, url) => {
    if (!alt.includes("\n")) {
      return `![${alt}](${url})`
    }
    const cleanAlt = alt.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim()
    return `![${cleanAlt}](${url})`
  })
  normalized = normalized.replace(/(!\[(?:\\.|[^\]])*]\()(https?:\/\/[^)]+)(\))/g, (_, prefix, url, suffix) => {
    const fixedUrl = url.replace(/\s+/g, "")
    return `${prefix}${fixedUrl}${suffix}`
  })
  normalized = stripTrailingKeyCitationsSection(normalized)
  normalized = normalized.replace(/\n{3,}/g, "\n\n")
  return normalized.trim()
}
