"use client"

import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react"
import { ChevronDown, ChevronRight, Globe, ImageIcon, Search, X } from "lucide-react"
import { Streamdown } from "streamdown"
import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "@/domain/chat/types"
import { cn } from "@/lib/utils"
import { GrokLogo } from "./claude-logo"

type TextSection = {
  type: "text"
  value: string
}

type ThinkSection = {
  type: "think"
  value: string
  open: boolean
  thinking: boolean
}

type MarkdownSection = TextSection | ThinkSection

type ThinkItem = {
  type: string
  body: string
}

type AgentDescriptor = {
  key: string
  label: string
  paletteIndex: number
  isPrimary?: boolean
}

type ThinkTimelineEntry =
  | {
      kind: "websearch"
      key: string
      text: string
      visited: boolean
      resultsCount?: number
    }
  | {
      kind: "agent"
      key: string
      body: string
      agentKey: string
      agentLabel: string
      paletteIndex: number
    }
  | {
      kind: "other"
      key: string
      label: string
      body: string
    }

const AGENT_PIXEL_PALETTES = [
  ["#111827", "#374151", "#6b7280", "#d1d5db"],
  ["#422006", "#78350f", "#d97706", "#fde68a"],
  ["#0f172a", "#1e293b", "#475569", "#cbd5e1"],
  ["#3f3f46", "#52525b", "#71717a", "#d4d4d8"],
] as const

const AGENT_STACK_RING_COLORS = ["#9ca3af", "#a3a3a3", "#b45309", "#64748b", "#52525b", "#a8a29e"] as const

type WebSearchToolMeta = {
  query: string
  numResults: number
}

type ImageCardMeta = {
  id: string
  cardType?: string
  type?: string
  url?: string
  image?: {
    thumbnail?: string
    original?: string
    title?: string
    link?: string
    source?: string
  }
}

type AssistantToolMeta = {
  webSearch: WebSearchToolMeta[]
  cards: Record<string, ImageCardMeta>
}

type StructuredReasoningEntry = {
  key: string
  toolUsageCardId: string
  rolloutId: string
  text: string
  visited: boolean
  toolName: string
  resultsCount?: number
  status: "running" | "completed"
}

type StructuredReasoningSummary = {
  entries: StructuredReasoningEntry[]
  rolloutIds: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeConsecutiveThinkSections(sections: MarkdownSection[]): MarkdownSection[] {
  if (sections.length <= 1) {
    return sections
  }

  const merged: MarkdownSection[] = []
  let thinkBuffer: ThinkSection | null = null

  const flushThinkBuffer = () => {
    if (!thinkBuffer) {
      return
    }
    merged.push({
      ...thinkBuffer,
      value: thinkBuffer.value.trim(),
    })
    thinkBuffer = null
  }

  for (const section of sections) {
    if (section.type === "think") {
      if (!thinkBuffer) {
        thinkBuffer = { ...section }
        continue
      }
      thinkBuffer = {
        type: "think",
        value: [thinkBuffer.value, section.value].filter(Boolean).join("\n\n"),
        open: thinkBuffer.open || section.open,
        thinking: thinkBuffer.thinking || section.thinking,
      }
      continue
    }

    flushThinkBuffer()
    merged.push(section)
  }

  flushThinkBuffer()
  return merged
}

function extractAssistantToolMeta(raw: string): { content: string; meta: AssistantToolMeta } {
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

function escapeMarkdownText(value: string): string {
  return value.replace(/[[\]\\]/g, "\\$&").replace(/\n+/g, " ").trim()
}

function wrapMarkdownUrl(url: string): string {
  // Avoid angle-bracket wrapping — causes issues in nested [![alt](src)](href) syntax
  return url.trim().replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

function toImageCardMeta(card: ChatCardAttachmentPayload): ImageCardMeta | null {
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

function collectCardsFromReasoningEvents(events: ChatReasoningEventDetail[]): Record<string, ImageCardMeta> {
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
    // Prefer thumbnail (Google image proxy) for display — it's CORS-friendly.
    // Source-site original URLs often block cross-origin/hotlinked loads.
    const imageUrl = card.image?.thumbnail || card.image?.original || card.url
    if (!imageUrl) {
      return ""
    }

    const alt = escapeMarkdownText(card.image?.title || card.image?.source || "Generated Image") || "Generated Image"
    const imageMarkdown = `![${alt}](${wrapMarkdownUrl(imageUrl)})`
    const targetUrl = card.image?.link || card.image?.original || card.url
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

function isLikelyImageUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:[?#].*)?$/i.test(text)
}

function isLikelyHttpUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^https?:\/\/[^\s<>"']+$/i.test(text)
}

function extractFirstImageUrlFromText(value: string): string {
  const match = /https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[^<>\s"]*)?/i.exec(value)
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

type ToolJsonLineRewrite =
  | {
      kind: "keep"
      line: string
    }
  | {
      kind: "drop"
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
    /<image>\s*(https?:\/\/[^\s<>"')]+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[^<>\s"]*)?)\s*<\/image>/gi,
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
  normalized = normalized.replace(/([\u4E00-\u9FFF）)])-(?=[\u4E00-\u9FFF0-9A-Za-z])/g, "$1\n- ")
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

export function parseThinkSections(
  raw: string,
  options?: {
    treatUnclosedThinkAsThinking?: boolean
  }
): MarkdownSection[] {
  const text = raw || ""
  if (!text.trim()) {
    return []
  }
  const treatUnclosedThinkAsThinking = options?.treatUnclosedThinkAsThinking ?? true

  const sections: MarkdownSection[] = []
  const lower = text.toLowerCase()
  const closeTag = "</think>"
  let cursor = 0

  while (cursor < text.length) {
    const start = lower.indexOf("<think", cursor)
    if (start < 0) {
      break
    }
    const startTagEnd = text.indexOf(">", start)
    if (startTagEnd < 0) {
      break
    }

    const before = text.slice(cursor, start)
    if (before.trim()) {
      sections.push({
        type: "text",
        value: before.replace(/<\/think>/gi, ""),
      })
    }

    const startTag = text.slice(start, startTagEnd + 1)
    const open = /\bopen\b/i.test(startTag)
    const close = lower.indexOf(closeTag, startTagEnd + 1)

    if (close < 0) {
      const thinkBody = text.slice(startTagEnd + 1)
      sections.push({
        type: "think",
        value: thinkBody,
        open: true,
        thinking: treatUnclosedThinkAsThinking,
      })
      cursor = text.length
      break
    }

    const thinkBody = text.slice(startTagEnd + 1, close)
    sections.push({
      type: "think",
      value: thinkBody,
      open,
      thinking: false,
    })
    cursor = close + closeTag.length
  }

  const tail = text.slice(cursor).replace(/<\/think>/gi, "")
  if (tail.trim()) {
    sections.push({
      type: "text",
      value: tail,
    })
  }

  if (sections.length === 0) {
    return mergeConsecutiveThinkSections([
      {
        type: "text",
        value: text.replace(/<\/think>/gi, ""),
      },
    ])
  }
  return mergeConsecutiveThinkSections(sections)
}

function parseThinkItems(content: string): ThinkItem[] {
  const items: ThinkItem[] = []
  const pattern = /\[([A-Za-z][A-Za-z0-9 _-]{0,32})\]\s*([\s\S]*?)(?=\s*\[[A-Za-z][A-Za-z0-9 _-]{0,32}\]\s*|$)/g
  let match: RegExpExecArray | null = pattern.exec(content)

  while (match) {
    const type = (match[1] || "").trim()
    const body = (match[2] || "").trim()
    if (type) {
      items.push({ type, body })
    }
    match = pattern.exec(content)
  }
  return items
}

function isWebSearchThinkItemType(type: string): boolean {
  const key = type.trim().toLowerCase().replace(/\s+/g, "")
  return key.includes("websearch")
}

function isAgentThinkItemType(type: string): boolean {
  const normalized = type.trim().toLowerCase()
  return /^agent\s*\d*$/i.test(type.trim()) || normalized === "grok"
}

function isAgentThinkContainerType(type: string): boolean {
  const normalized = type.trim().toLowerCase().replace(/[\s_-]+/g, "")
  return normalized === "agentthink" || normalized === "agentthought" || normalized === "multiagent"
}

function isLikelyUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}(?:\/|$))/i.test(text)
}

function decodeUrlForDisplay(value: string): string {
  const text = value.trim()
  if (!text || !text.includes("%")) {
    return value
  }
  try {
    return decodeURI(text)
  } catch {
    return value
  }
}

function formatSearchTextForDisplay(value: string): string {
  if (!isLikelyUrl(value)) {
    return value
  }
  return decodeUrlForDisplay(value)
}

function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
}

function isEmptyThinkBody(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return true
  }
  return /^(?:\(空\)|（空）|\[空\]|空|none|null|n\/a|na|-)$/i.test(text)
}

function parseAgentMeta(type: string, fallbackIndex: number): AgentDescriptor | null {
  if (!isAgentThinkItemType(type)) {
    return null
  }

  const trimmed = type.trim()
  if (trimmed.toLowerCase() === "grok") {
    return {
      key: "grok_primary",
      label: "Grok",
      paletteIndex: 0,
      isPrimary: true,
    }
  }
  const match = /^agent\s*(\d+)?$/i.exec(trimmed)
  const number = match?.[1] ? Number.parseInt(match[1], 10) : null
  const order = Number.isFinite(number) && number ? number : fallbackIndex + 1
  const label = number ? `Agent ${number}` : `Agent ${fallbackIndex + 1}`

  return {
    key: label.toLowerCase().replace(/\s+/g, "_"),
    label,
    paletteIndex: Math.abs(order - 1) % AGENT_PIXEL_PALETTES.length,
  }
}

function extractNestedAgentEntries(body: string): Array<{ label: string; body: string }> {
  const entries: Array<{ label: string; body: string }> = []
  const patterns = [
    /\[(Grok|Agent\s*\d+)\]\s*([\s\S]*?)(?=\s*\[(?:Grok|Agent\s*\d+)\]\s*|$)/gi,
    /(?:^|\n)\s*(Grok|Agent\s*\d+)\s*[:：-]\s*([\s\S]*?)(?=(?:\n\s*(?:Grok|Agent\s*\d+)\s*[:：-])|$)/gi,
  ]

  for (const pattern of patterns) {
    pattern.lastIndex = 0
    const nextEntries: Array<{ label: string; body: string }> = []
    let match: RegExpExecArray | null = pattern.exec(body)

    while (match) {
      const label = (match[1] || "").trim()
      const value = (match[2] || "").trim()
      if (label && !isEmptyThinkBody(value)) {
        nextEntries.push({ label, body: value })
      }
      match = pattern.exec(body)
    }

    if (nextEntries.length > 0) {
      return nextEntries
    }
  }

  return entries
}

function collectAgentDescriptors(items: ThinkItem[]): AgentDescriptor[] {
  const descriptors: AgentDescriptor[] = [
    {
      key: "grok_primary",
      label: "Grok",
      paletteIndex: 0,
      isPrimary: true,
    },
  ]
  const seen = new Set<string>(["grok_primary"])
  let anonymousAgentIndex = 1

  const appendDescriptor = (meta: AgentDescriptor | null) => {
    if (!meta || seen.has(meta.key)) {
      return
    }
    seen.add(meta.key)
    descriptors.push(meta)
  }

  items.forEach((item, index) => {
    if (isAgentThinkContainerType(item.type)) {
      const nested = extractNestedAgentEntries(item.body)
      if (nested.length > 0) {
        nested.forEach((entry, nestedIndex) => {
          appendDescriptor(parseAgentMeta(entry.label, nestedIndex))
        })
        return
      }

      if (!isEmptyThinkBody(item.body)) {
        appendDescriptor(parseAgentMeta(`Agent ${anonymousAgentIndex}`, anonymousAgentIndex - 1))
        anonymousAgentIndex += 1
      }
      return
    }

    const meta = parseAgentMeta(item.type, index)
    appendDescriptor(meta)
  })

  return descriptors
}

function buildThinkTimeline(items: ThinkItem[], toolMeta: AssistantToolMeta): ThinkTimelineEntry[] {
  const timeline: ThinkTimelineEntry[] = []
  let anonymousAgentIndex = 1
  const usedWebSearchMeta = new Set<number>()

  const claimNextUnusedResults = (): number | undefined => {
    for (let index = 0; index < toolMeta.webSearch.length; index += 1) {
      if (usedWebSearchMeta.has(index)) {
        continue
      }
      const item = toolMeta.webSearch[index]
      if (!item || !Number.isFinite(item.numResults) || item.numResults <= 0) {
        continue
      }
      usedWebSearchMeta.add(index)
      return item.numResults
    }
    return undefined
  }

  const findResultsCount = (query: string): number | undefined => {
    const normalizedQuery = normalizeSearchQuery(query)
    if (normalizedQuery) {
      for (let index = 0; index < toolMeta.webSearch.length; index += 1) {
        if (usedWebSearchMeta.has(index)) {
          continue
        }
        const item = toolMeta.webSearch[index]
        if (!item) {
          continue
        }
        const normalizedItemQuery = normalizeSearchQuery(item.query)
        const strictMatch = normalizedItemQuery === normalizedQuery
        const fuzzyMatch =
          normalizedItemQuery.length >= 6 &&
          normalizedQuery.length >= 6 &&
          (normalizedItemQuery.includes(normalizedQuery) || normalizedQuery.includes(normalizedItemQuery))
        if (!strictMatch && !fuzzyMatch) {
          continue
        }
        usedWebSearchMeta.add(index)
        return item.numResults
      }
    }
    // Upstream think text and tool query text may diverge; fallback to chronological mapping.
    return claimNextUnusedResults()
  }

  items.forEach((item, index) => {
    if (isWebSearchThinkItemType(item.type)) {
      const lines = item.body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !isEmptyThinkBody(line))

      lines.forEach((line, lineIndex) => {
        if (isEmptyThinkBody(line)) {
          return
        }
        timeline.push({
          kind: "websearch",
          key: `web-${index}-${lineIndex}`,
          text: line,
          visited: isLikelyUrl(line),
          resultsCount: isLikelyUrl(line) ? undefined : findResultsCount(line),
        })
      })
      return
    }

    if (isAgentThinkContainerType(item.type)) {
      const nested = extractNestedAgentEntries(item.body)
      if (nested.length > 0) {
        nested.forEach((entry, nestedIndex) => {
          const meta = parseAgentMeta(entry.label, nestedIndex)
          if (!meta || isEmptyThinkBody(entry.body)) {
            return
          }
          timeline.push({
            kind: "agent",
            key: `agent-nested-${index}-${nestedIndex}`,
            body: entry.body,
            agentKey: meta.key,
            agentLabel: meta.label,
            paletteIndex: meta.paletteIndex,
          })
        })
        return
      }

      if (!isEmptyThinkBody(item.body)) {
        const meta = parseAgentMeta(`Agent ${anonymousAgentIndex}`, anonymousAgentIndex - 1)
        anonymousAgentIndex += 1
        if (meta) {
          timeline.push({
            kind: "agent",
            key: `agent-anon-${index}`,
            body: item.body,
            agentKey: meta.key,
            agentLabel: meta.label,
            paletteIndex: meta.paletteIndex,
          })
        }
      }
      return
    }

    const meta = parseAgentMeta(item.type, index)
    if (meta) {
      if (isEmptyThinkBody(item.body)) {
        return
      }
      timeline.push({
        kind: "agent",
        key: `agent-${index}`,
        body: item.body,
        agentKey: meta.key,
        agentLabel: meta.label,
        paletteIndex: meta.paletteIndex,
      })
      return
    }

    if (isEmptyThinkBody(item.body)) {
      return
    }

    timeline.push({
      kind: "other",
      key: `other-${index}`,
      label: item.type,
      body: item.body,
    })
  })

  return timeline
}

function findLatestAgentKey(timeline: ThinkTimelineEntry[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const current = timeline[index]
    if (current?.kind === "agent") {
      return current.agentKey
    }
  }
  return "grok_primary"
}

function normalizeRolloutId(value: string | undefined): string {
  const trimmed = (value || "").trim()
  return trimmed || "Grok"
}

function readStringListFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function readToolUsageQueries(args: Record<string, unknown>): string[] {
  const values: string[] = []
  const seen = new Set<string>()
  const append = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed || seen.has(trimmed)) {
      return
    }
    seen.add(trimmed)
    values.push(trimmed)
  }

  for (const key of ["query", "q", "url", "keyword", "imageDescription", "image_description", "prompt"]) {
    for (const row of readStringListFromUnknown(args[key])) {
      append(row)
    }
  }

  for (const key of ["queries", "q", "urls", "keywords", "prompts"]) {
    for (const row of readStringListFromUnknown(args[key])) {
      append(row)
    }
  }

  if (values.length > 0) {
    return values
  }

  for (const value of Object.values(args)) {
    for (const row of readStringListFromUnknown(value)) {
      append(row)
      if (values.length >= 2) {
        return values
      }
    }
  }

  return values
}

function readRequestedResultsCount(args: Record<string, unknown>): number | undefined {
  for (const key of ["num_results", "number_of_images", "limit", "max_results", "result_count"]) {
    const value = args[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed
      }
    }
  }
  return undefined
}

function isImageSearchToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.includes("search_image") || normalized.includes("imagesearch") || normalized.includes("image_search")
}

function isXSearchToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith("x_") || normalized.includes("xsearch")
}

function humanizeToolName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return "tool"
  }
  if (isImageSearchToolName(trimmed)) {
    return "已搜索图像"
  }
  if (isXSearchToolName(trimmed)) {
    return "已搜索 X"
  }
  if (trimmed.toLowerCase().includes("search")) {
    return "已搜索的网络"
  }
  return trimmed.replace(/[_-]+/g, " ")
}

function resolveStructuredEntryLabel(toolName: string, visited: boolean, status?: string): string {
  if (visited) {
    return "已浏览网页"
  }
  if (isImageSearchToolName(toolName)) {
    return status === "completed" ? "已搜索图像" : "搜索图像"
  }
  if (isXSearchToolName(toolName)) {
    return status === "completed" ? "已搜索 X" : "搜索 X"
  }
  if (toolName.toLowerCase().includes("search")) {
    return status === "completed" ? "已搜索的网络" : "搜索网页"
  }
  return humanizeToolName(toolName)
}

function buildStructuredReasoningSummary(events: ChatReasoningEventDetail[]): StructuredReasoningSummary {
  const entries: StructuredReasoningEntry[] = []
  const entryByKey = new Map<string, StructuredReasoningEntry>()
  const entryByToolUsageCardId = new Map<string, StructuredReasoningEntry[]>()
  const rolloutIds: string[] = []
  const rolloutSeen = new Set<string>()

  const appendRollout = (rolloutId: string | undefined) => {
    const normalized = normalizeRolloutId(rolloutId)
    if (rolloutSeen.has(normalized)) {
      return
    }
    rolloutSeen.add(normalized)
    rolloutIds.push(normalized)
  }

  for (const detail of events) {
    if (detail.kind === "ui_layout") {
      const ids = Array.isArray(detail.layout.rolloutIds) ? detail.layout.rolloutIds : []
      if (ids.length > 0) {
        for (const rolloutId of ids) {
          appendRollout(rolloutId)
        }
      }
      continue
    }

    if (detail.kind === "card_attachment") {
      continue
    }

    if (detail.kind === "tool_usage") {
      appendRollout(detail.usage.rolloutId)

      const queries = readToolUsageQueries(detail.usage.args)
      const lines = queries.length > 0 ? queries : [humanizeToolName(detail.usage.toolName)]
      const requestedResultsCount = readRequestedResultsCount(detail.usage.args)
      const scopedEntries: StructuredReasoningEntry[] = []

      lines.forEach((line, queryIndex) => {
        const key = `${detail.usage.toolUsageCardId}:${queryIndex}`
        if (entryByKey.has(key)) {
          return
        }
        const nextEntry: StructuredReasoningEntry = {
          key,
          toolUsageCardId: detail.usage.toolUsageCardId,
          rolloutId: normalizeRolloutId(detail.usage.rolloutId),
          text: line,
          visited: isLikelyUrl(line),
          toolName: detail.usage.toolName,
          resultsCount: requestedResultsCount,
          status: "running",
        }
        entryByKey.set(key, nextEntry)
        scopedEntries.push(nextEntry)
        entries.push(nextEntry)
      })

      if (scopedEntries.length > 0) {
        entryByToolUsageCardId.set(detail.usage.toolUsageCardId, scopedEntries)
      }

      continue
    }

    if (detail.kind === "tool_result") {
      appendRollout(detail.result.rolloutId)
      const toolUsageCardId = detail.result.toolUsageCardId
      if (!toolUsageCardId) {
        continue
      }

      const scopedEntries = entryByToolUsageCardId.get(toolUsageCardId)
      if (scopedEntries && scopedEntries.length > 0) {
        scopedEntries.forEach((entry) => {
          entry.status = "completed"
          if (typeof detail.result.webSearchResultsCount === "number") {
            entry.resultsCount = detail.result.webSearchResultsCount
          }
        })
        continue
      }

      const fallbackKey = `${toolUsageCardId}:result`
      if (entryByKey.has(fallbackKey)) {
        continue
      }
      const fallbackEntry: StructuredReasoningEntry = {
        key: fallbackKey,
        toolUsageCardId,
        rolloutId: normalizeRolloutId(detail.result.rolloutId),
        text: "已搜索网络",
        visited: false,
        toolName: "web_search",
        status: "completed",
        resultsCount:
          typeof detail.result.webSearchResultsCount === "number"
            ? detail.result.webSearchResultsCount
            : undefined,
      }
      entryByKey.set(fallbackKey, fallbackEntry)
      entryByToolUsageCardId.set(toolUsageCardId, [fallbackEntry])
      entries.push(fallbackEntry)
    }
  }

  if (rolloutIds.length === 0) {
    rolloutIds.push("Grok")
  }

  return {
    entries,
    rolloutIds,
  }
}

function AgentCanvasOrb({
  paletteIndex,
  active,
  thinking,
  size = "md",
  isPrimary = false,
}: {
  paletteIndex: number
  active: boolean
  thinking: boolean
  size?: "sm" | "md" | "lg"
  isPrimary?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const tickRef = useRef(0)

  // Grok uses golden angle to distribute base hues. If it's the primary agent, use Grok's signature red/orange.
  const baseHue = useMemo(() => (isPrimary ? 12 : (137.508 * (paletteIndex + 1)) % 360), [paletteIndex, isPrimary])

  // Draw smooth organic blobs to canvas
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, time: number) => {
      const w = 64
      const h = 64
      ctx.clearRect(0, 0, w, h)
      
      // Draw a base background
      const baseGrad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w/2)
      baseGrad.addColorStop(0, `hsl(${baseHue}, 85%, 55%)`)
      baseGrad.addColorStop(1, `hsl(${(baseHue + 40) % 360}, 90%, 35%)`)
      ctx.fillStyle = baseGrad
      ctx.fillRect(0, 0, w, h)

      // Only animate internal blobs if "thinking"
      const t = thinking ? time * 0.002 : 0

      // Draw 3 moving "blobs" of color to create the organic fluid effect
      const blobs = [
        { hueOff: -30, size: 28, x: w/2 + Math.sin(t * 1.2) * 12, y: h/2 + Math.cos(t * 1.3) * 12 },
        { hueOff: 45,  size: 32, x: w/2 + Math.sin(t * 1.5 + 2) * 14, y: h/2 + Math.cos(t * 1.1 + 3) * 14 },
        { hueOff: 15,  size: 24, x: w/2 + Math.cos(t * 0.9 + 4) * 16, y: h/2 + Math.sin(t * 1.4 + 1) * 16 }
      ]

      // Set global composite operation for smooth blending
      ctx.globalCompositeOperation = 'screen'

      blobs.forEach(blob => {
        const grad = ctx.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, blob.size)
        grad.addColorStop(0, `hsla(${(baseHue + blob.hueOff + 360) % 360}, 90%, 65%, 0.8)`)
        grad.addColorStop(1, `hsla(${(baseHue + blob.hueOff + 360) % 360}, 90%, 65%, 0)`)
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)
      })

      ctx.globalCompositeOperation = 'source-over'
    },
    [baseHue, thinking]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    
    // Apply blur filter on the 64x64 canvas for ultra-smoothness
    ctx.filter = 'blur(6px)'

    if (thinking) {
      const loop = () => {
        tickRef.current += 16
        draw(ctx, tickRef.current)
        rafRef.current = requestAnimationFrame(loop)
      }
      loop()
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
      }
    } else {
      draw(ctx, 0)
    }
  }, [draw, thinking])

  const pxSize = size === "sm" ? 18 : size === "lg" ? 28 : 20

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full shadow-[inset_0_1px_3px_rgba(255,255,255,0.3)]",
        active ? "ring-2 ring-foreground/20 ring-offset-2 ring-offset-background" : ""
      )}
      style={{ width: pxSize, height: pxSize }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        width={64}
        height={64}
        style={{
          width: pxSize,
          height: pxSize,
          imageRendering: "auto" as const, // explicitly use smooth rendering
        }}
        className="scale-125" // Scale up slightly to hide blurred edges
      />
    </span>
  )
}

function AgentIconOrb({
  paletteIndex,
  active,
  thinking,
  size = "md",
  animationDelayMs = 0,
}: {
  paletteIndex: number
  active: boolean
  thinking: boolean
  size?: "sm" | "md" | "lg"
  animationDelayMs?: number
}) {
  const ringColor = AGENT_STACK_RING_COLORS[Math.abs(paletteIndex) % AGENT_STACK_RING_COLORS.length]
  const shellStyle = {
    animationDelay: `${animationDelayMs}ms`,
    borderColor: ringColor,
  } as const

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        active ? "think-grok-orb" : ""
      )}
      aria-hidden="true"
    >
      {active ? <span className="absolute -inset-[2.5px] rounded-full think-agent-active-halo" /> : null}
      <AgentCanvasOrb
        paletteIndex={paletteIndex}
        active={active}
        thinking={thinking}
        size={size}
      />
    </span>
  )
}

// Removed GrokPrimaryOrb. Replaced with AgentCanvasOrb usage.

function AgentAvatarStack({
  agents,
  activeAgentKey,
  thinking,
}: {
  agents: AgentDescriptor[]
  activeAgentKey: string
  thinking: boolean
}) {
  const visibleAgents = agents.slice(0, 5)

  return (
    <span className="inline-flex items-center -space-x-1.5">
      {visibleAgents.map((agent, index) =>
        agent.isPrimary ? (
          <AgentCanvasOrb key={agent.key} paletteIndex={0} isPrimary={true} active={agent.key === activeAgentKey} thinking={thinking} size="sm" />
        ) : (
          <AgentIconOrb
            key={agent.key}
            paletteIndex={agent.paletteIndex}
            active={agent.key === activeAgentKey}
            thinking={thinking}
            size="sm"
            animationDelayMs={index * 130}
          />
        )
      )}
      {agents.length > visibleAgents.length ? (
        <span className="ml-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border bg-background px-1 text-[10px] font-medium text-muted-foreground">
          +{agents.length - visibleAgents.length}
        </span>
      ) : null}
    </span>
  )
}

function collectRolloutAgents(rolloutIds: string[]): AgentDescriptor[] {
  const agents: AgentDescriptor[] = []
  const seen = new Set<string>()

  const append = (next: AgentDescriptor) => {
    if (seen.has(next.key)) {
      return
    }
    seen.add(next.key)
    agents.push(next)
  }

  append({
    key: "grok_primary",
    label: "Grok",
    paletteIndex: 0,
    isPrimary: true,
  })

  rolloutIds.forEach((rolloutId, index) => {
    const normalized = rolloutId.trim()
    if (!normalized || normalized.toLowerCase() === "grok") {
      return
    }
    const known = parseAgentMeta(normalized, index)
    if (known) {
      append(known)
      return
    }
    append({
      key: normalized.toLowerCase().replace(/\s+/g, "_"),
      label: normalized,
      paletteIndex: (index + 1) % AGENT_PIXEL_PALETTES.length,
    })
  })

  return agents
}

function toAgentKey(rolloutId: string): string {
  const normalized = rolloutId.trim().toLowerCase()
  if (!normalized || normalized === "grok") {
    return "grok_primary"
  }
  return normalized.replace(/\s+/g, "_")
}

function resolveAgentDescriptorByKey(agents: AgentDescriptor[], key: string): AgentDescriptor {
  const found = agents.find((agent) => agent.key === key)
  if (found) {
    return found
  }
  return {
    key,
    label: key === "grok_primary" ? "Grok" : key.replace(/_/g, " "),
    paletteIndex: 0,
    isPrimary: key === "grok_primary",
  }
}

function StructuredReasoningPanel({
  events,
  isThinking,
}: {
  events: ChatReasoningEventDetail[]
  isThinking: boolean
}) {
  const summary = useMemo(() => buildStructuredReasoningSummary(events), [events])
  const effectiveThinkingRaw = useMemo(
    () => isThinking || summary.entries.some((entry) => entry.status === "running"),
    [isThinking, summary.entries]
  )
  const [thinkingStable, setThinkingStable] = useState(effectiveThinkingRaw)
  const agents = useMemo(() => collectRolloutAgents(summary.rolloutIds), [summary.rolloutIds])
  const agentByKey = useMemo(() => {
    const map = new Map<string, AgentDescriptor>()
    for (const agent of agents) {
      map.set(agent.key, agent)
    }
    return map
  }, [agents])
  const [activeTick, setActiveTick] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const startedAtRef = useRef<number | null>(effectiveThinkingRaw ? Date.now() : null)
  const thinkingStopTimerRef = useRef<number | null>(null)
  const previousEntryCountRef = useRef(summary.entries.length)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const effectiveThinking = thinkingStable
  const displayEntries = useMemo(() => {
    if (!effectiveThinking) {
      return summary.entries
    }
    return summary.entries.slice(-3)
  }, [effectiveThinking, summary.entries])

  const latestAgentKey = useMemo(() => {
    for (let index = summary.entries.length - 1; index >= 0; index -= 1) {
      const entry = summary.entries[index]
      if (!entry) {
        continue
      }
      return toAgentKey(entry.rolloutId)
    }
    return "grok_primary"
  }, [summary.entries])

  const activeAgentKey = useMemo(() => {
    if (effectiveThinking) {
      for (let index = summary.entries.length - 1; index >= 0; index -= 1) {
        const entry = summary.entries[index]
        if (!entry || entry.status !== "running") {
          continue
        }
        return toAgentKey(entry.rolloutId)
      }
      if (agents.length > 0) {
        return agents[activeTick % agents.length]?.key || "grok_primary"
      }
      return "grok_primary"
    }
    return latestAgentKey
  }, [activeTick, agents, effectiveThinking, latestAgentKey, summary.entries])

  useEffect(() => {
    if (effectiveThinkingRaw) {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
        thinkingStopTimerRef.current = null
      }
      if (!startedAtRef.current) {
        startedAtRef.current = Date.now()
      }
      setThinkingStable(true)
    } else if (startedAtRef.current) {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
      }
      thinkingStopTimerRef.current = window.setTimeout(() => {
        setThinkingStable(false)
        setExpanded(false)
        thinkingStopTimerRef.current = null
        const elapsed = Math.max(1, Math.round((Date.now() - (startedAtRef.current || Date.now())) / 1000))
        setDurationSeconds(elapsed)
      }, 650)
    }
  }, [effectiveThinkingRaw])

  useEffect(
    () => () => {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    if (!effectiveThinking || agents.length <= 1) {
      return
    }
    const timer = window.setInterval(() => {
      setActiveTick((value) => value + 1)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, effectiveThinking])

  useEffect(() => {
    if (!effectiveThinking || !startedAtRef.current) {
      return
    }

    const syncElapsed = () => {
      if (!startedAtRef.current) {
        return
      }
      const elapsed = Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
    }

    syncElapsed()
    const timer = window.setInterval(syncElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [effectiveThinking])

  useEffect(() => {
    if (!effectiveThinking) {
      previousEntryCountRef.current = summary.entries.length
      return
    }
    const currentCount = summary.entries.length
    const previousCount = previousEntryCountRef.current
    previousEntryCountRef.current = currentCount
    if (currentCount <= previousCount) {
      return
    }

    const node = timelineRef.current
    if (!node) {
      return
    }
    const raf = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(raf)
  }, [effectiveThinking, summary.entries.length])

  const hasAgentItems = agents.length > 1
  const summaryLabel = hasAgentItems
    ? (effectiveThinking ? "代理人思维方式" : "代理人思维方式")
    : (effectiveThinking ? "思考中" : "思考过程")
  const durationLabel = durationSeconds > 0 || effectiveThinking ? ` · ${durationSeconds || 0}s` : ""
  const hasAnyRecords = summary.entries.length > 0
  const showPanel = effectiveThinking || hasAnyRecords
  const bodyExpanded = effectiveThinking || expanded

  if (!showPanel) {
    return null
  }

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-muted-foreground"
        onClick={() => {
          if (effectiveThinking) {
            return
          }
          setExpanded((value) => !value)
        }}
      >
        {bodyExpanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground/85 transition-transform duration-200" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/85 transition-transform duration-200" />
        )}
        <span className={cn(
          "inline-flex items-center gap-1.5 rounded-full py-1 px-2.5 transition-all duration-300",
          effectiveThinking
            ? "border border-border/40 bg-background/60 shadow-sm backdrop-blur-md"
            : "border-transparent bg-transparent py-0 px-0"
        )}>
          <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={effectiveThinking} />
          <span
            className={cn(
              "text-sm font-medium whitespace-nowrap",
              effectiveThinking ? "text-foreground/80" : "text-muted-foreground"
            )}
          >
            {summaryLabel}
            <span className="text-muted-foreground">{durationLabel}</span>
          </span>
        </span>
      </button>
      <div
        className={cn(
          "transition-all duration-200 ease-out",
          bodyExpanded ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0"
        )}
      >
        <div className="rounded-2xl border border-border/40 bg-card/50 px-4 py-3">
        <div
          ref={timelineRef}
          className={cn(
            effectiveThinking
              ? "relative max-h-[18rem] overflow-hidden"
              : "max-h-[65vh] overflow-auto pr-2 text-xs text-muted-foreground"
          )}
        >
          {displayEntries.length > 0 ? (
            <div className={cn(effectiveThinking ? "flex min-h-[12.5rem] flex-col justify-end gap-2" : "space-y-2")}>
              {displayEntries.map((entry, index) => {
                const active =
                  effectiveThinking && entry.status === "running" && toAgentKey(entry.rolloutId) === activeAgentKey
                const entryAgentKey = toAgentKey(entry.rolloutId)
                const descriptor = agentByKey.get(entryAgentKey) || resolveAgentDescriptorByKey(agents, entryAgentKey)
                const key = `${entry.key}:${index}`
                const ageFromNewest = displayEntries.length - 1 - index
                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-start justify-between gap-3 py-1 transition-all duration-200",
                      effectiveThinking ? "think-stream-row" : "",
                      effectiveThinking && ageFromNewest >= 2
                        ? "think-stream-row-oldest"
                        : effectiveThinking && ageFromNewest === 1
                          ? "think-stream-row-middle"
                          : effectiveThinking
                            ? "think-stream-row-newest"
                            : "",
                      active ? "think-stream-row-active" : ""
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className="mt-1 inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                        {entry.visited ? (
                          <Globe className="size-4" />
                        ) : isImageSearchToolName(entry.toolName) ? (
                          <ImageIcon className="size-4" />
                        ) : (
                          <Search className="size-4" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] leading-5 text-muted-foreground">
                          {resolveStructuredEntryLabel(entry.toolName, entry.visited, entry.status)}
                        </p>
                        <p
                          className={cn(
                            "break-all text-sm font-medium leading-6 text-foreground",
                            entry.visited ? "italic" : ""
                          )}
                        >
                          {formatSearchTextForDisplay(entry.text)}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                      {typeof entry.resultsCount === "number" ? (
                        <span className="inline-flex items-center rounded-md border border-foreground/[0.06] bg-secondary/50 px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground">
                          {entry.resultsCount} 结果
                        </span>
                      ) : null}
                      {effectiveThinking ? (
                        <span className="inline-flex shrink-0 items-center justify-center">
                          <AgentCanvasOrb
                            paletteIndex={descriptor.isPrimary ? 0 : descriptor.paletteIndex}
                            isPrimary={descriptor.isPrimary}
                            active={active}
                            thinking={effectiveThinking}
                            size="sm"
                          />
                        </span>
                      ) : null}
                      {active ? <span className="size-1.5 animate-pulse rounded-full bg-foreground/60" /> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : effectiveThinking ? (
            <div className="space-y-2 pt-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-secondary/70" />
              <div className="h-5 w-full animate-pulse rounded bg-secondary/60" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-secondary/60" />
            </div>
          ) : (
            <p className="pt-2 text-[0.9rem] text-muted-foreground">暂无思考记录</p>
          )}
          {effectiveThinking ? (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-card/80 via-card/60 to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card/80 via-card/60 to-transparent" />
            </>
          ) : null}
        </div>
        </div>
      </div>
    </div>
  )
}

function isAnchorImageNode(node: ReactNode): boolean {
  if (!isValidElement(node)) {
    return false
  }
  const props = node.props as { href?: unknown; children?: ReactNode }
  if (typeof props.href !== "string") {
    return false
  }
  const childNodes = Children.toArray(props.children).filter(
    (item) => !(typeof item === "string" && item.trim() === "")
  )
  return childNodes.length === 1 && isImageNode(childNodes[0])
}

function isImageNode(node: ReactNode): boolean {
  if (!isValidElement(node)) {
    return false
  }
  const props = node.props as { src?: unknown }
  if (typeof props.src === "string" && props.src.trim() !== "") {
    return true
  }
  if (typeof node.type === "string" && node.type === "img") {
    return true
  }
  return isAnchorImageNode(node)
}

function collectImageOnlyNodes(node: ReactNode): ReactNode[] | null {
  if (typeof node === "string") {
    return node.trim() ? null : []
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return []
  }

  if (isImageNode(node)) {
    return [node]
  }

  if (!isValidElement(node)) {
    return null
  }

  const props = node.props as { children?: ReactNode }
  if (props.children === undefined) {
    return null
  }

  const nested: ReactNode[] = []
  for (const child of Children.toArray(props.children)) {
    const rows = collectImageOnlyNodes(child)
    if (!rows) {
      return null
    }
    nested.push(...rows)
  }
  return nested
}

function collectImageParagraphNodes(children: ReactNode): ReactNode[] | null {
  const rows: ReactNode[] = []
  for (const child of Children.toArray(children)) {
    const nested = collectImageOnlyNodes(child)
    if (!nested) {
      return null
    }
    rows.push(...nested)
  }
  return rows.length > 0 ? rows : null
}



const MarkdownImage = memo(function({
  src,
  alt,
}: {
  src: string
  alt: string
}) {
  const [currentSrc, setCurrentSrc] = useState(src || "")
  const [failed, setFailed] = useState(false)
  const swappedProtocolRef = useRef(false)

  useEffect(() => {
    setCurrentSrc(src || "")
    setFailed(false)
    swappedProtocolRef.current = false
  }, [src])

  const handleError = (_event: SyntheticEvent<HTMLImageElement>) => {
    if (swappedProtocolRef.current) {
      setFailed(true)
      return
    }
    const value = (currentSrc || "").trim()
    if (value.startsWith("https://")) {
      swappedProtocolRef.current = true
      setFailed(false)
      setCurrentSrc(`http://${value.slice("https://".length)}`)
      return
    }
    if (value.startsWith("http://")) {
      swappedProtocolRef.current = true
      setFailed(false)
      setCurrentSrc(`https://${value.slice("http://".length)}`)
      return
    }
    setFailed(true)
  }

  const retryImage = () => {
    const value = (src || "").trim()
    if (!value) {
      return
    }
    swappedProtocolRef.current = false
    setFailed(false)
    const separator = value.includes("?") ? "&" : "?"
    setCurrentSrc(`${value}${separator}retry=${Date.now()}`)
  }

  if (failed || !currentSrc.trim()) {
    const fallbackLink = currentSrc.trim() || (src || "").trim()
    return (
      <div className="flex w-full flex-col items-center justify-center gap-2 bg-secondary/30 px-4 py-4 text-center text-sm text-muted-foreground">
        <span>图片加载失败</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full bg-secondary px-3 py-1 text-xs text-foreground transition-colors hover:bg-secondary/80"
            onClick={retryImage}
          >
            重试
          </button>
          {fallbackLink ? (
            <a
              href={fallbackLink}
              className="text-xs text-claude-sienna underline decoration-claude-sienna/45 underline-offset-2"
              target="_blank"
              rel="noreferrer noopener"
            >
              打开原图
            </a>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <img
      src={currentSrc}
      alt={alt || ""}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={handleError}
      className="grok-md-image block h-auto max-h-[72vh] w-full rounded-[20px] bg-secondary/20 object-contain"
      data-grok-md-image="true"
    />
  )
})

function MarkdownBody({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  if (!normalized) {
    return null
  }

  return (
    <Streamdown
      isAnimating={streaming}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
        p: ({ children }) => {
          const imageNodes = collectImageParagraphNodes(children)
          if (!imageNodes) {
            return <p className="leading-7">{children}</p>
          }

          const imageCount = imageNodes.length
          const galleryColumnsClass =
            imageCount <= 1 ? "grid-cols-1" : imageCount === 2 ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3"

          return (
            <div className="my-2 w-full">
              <div
                className={cn(
                  "grok-md-image-grid grid gap-[2px] overflow-hidden rounded-[24px]",
                  galleryColumnsClass,
                  imageCount === 1 ? "grok-md-image-grid-single max-w-[32rem]" : ""
                )}
              >
                {imageNodes.map((node, index) => (
                  <div key={index} className="overflow-hidden bg-secondary/20">
                    {node}
                  </div>
                ))}
              </div>
            </div>
          )
        },
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
        li: ({ children }) => <li className="leading-7">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-claude-sienna underline decoration-claude-sienna/50 underline-offset-2"
            target="_blank"
            rel="noreferrer noopener"
          >
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-claude-sienna pl-3 text-muted-foreground italic">
            {children}
          </blockquote>
        ),
        img: ({ src, alt }) => <MarkdownImage src={src || ""} alt={alt || ""} />,
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-secondary/40 p-3">{children}</pre>
        ),
        code: ({ className, children }) => {
          const isBlock = Boolean(className)
          if (isBlock) {
            return <code className="font-mono text-sm">{children}</code>
          }
          return (
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-sm text-foreground">
              {children}
            </code>
          )
        },
        hr: () => <hr className="my-3 border-border" />,
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-secondary/60">{children}</thead>,
        th: ({ children }) => <th className="border border-border px-3 py-2 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-border px-3 py-2 align-top">{children}</td>,
      }}
    >
      {normalized}
    </Streamdown>
  )
}

function ThinkBlock({
  content,
  open,
  thinking,
  toolMeta,
}: {
  content: string
  open: boolean
  thinking: boolean
  toolMeta: AssistantToolMeta
}) {
  const [expanded, setExpanded] = useState(open || thinking)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const [activeTick, setActiveTick] = useState(0)
  const startedAtRef = useRef<number | null>(thinking ? Date.now() : null)
  const previousThinkingRef = useRef(thinking)
  const collapseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (thinking) {
      if (collapseTimerRef.current) {
        window.clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
      if (!startedAtRef.current) {
        startedAtRef.current = Date.now()
      }
      setExpanded(true)
    } else if (startedAtRef.current) {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
    }

    if (previousThinkingRef.current && !thinking) {
      collapseTimerRef.current = window.setTimeout(() => {
        setExpanded(false)
        collapseTimerRef.current = null
      }, 450)
    }
    previousThinkingRef.current = thinking
  }, [thinking])

  useEffect(
    () => () => {
      if (collapseTimerRef.current) {
        window.clearTimeout(collapseTimerRef.current)
      }
    },
    []
  )

  const items = useMemo(() => parseThinkItems(content), [content])
  const timeline = useMemo(() => buildThinkTimeline(items, toolMeta), [items, toolMeta])
  const latestTimeline = useMemo(() => timeline.slice(-3), [timeline])
  const displayTimeline = thinking ? latestTimeline : timeline
  const agents = useMemo(() => collectAgentDescriptors(items), [items])
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  const hasAgentItems = agents.length > 0
  const latestAgentKey = useMemo(() => findLatestAgentKey(timeline), [timeline])
  const rotatingAgentKey = agents.length > 0 ? agents[activeTick % agents.length]?.key || "" : ""
  const activeAgentKey = thinking ? rotatingAgentKey || latestAgentKey : latestAgentKey
  const summaryLabel = hasAgentItems ? "代理人思维方式" : thinking ? "思考中" : "思考"
  const durationLabel = durationSeconds > 0 || thinking ? ` · ${durationSeconds || 0}s` : ""
  const containerClassName = thinking ? "text-xs text-muted-foreground" : "max-h-[65vh] overflow-auto pr-2 text-xs text-muted-foreground"

  useEffect(() => {
    if (!thinking || !startedAtRef.current) {
      return
    }

    const syncElapsed = () => {
      if (!startedAtRef.current) {
        return
      }
      const elapsed = Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
    }

    syncElapsed()
    const timer = window.setInterval(syncElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [thinking])

  useEffect(() => {
    if (!thinking || agents.length <= 1) {
      return
    }

    const timer = window.setInterval(() => {
      setActiveTick((value) => value + 1)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, thinking])

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-2.5 text-muted-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/85 transition-transform duration-200",
            expanded ? "rotate-90" : ""
          )}
        />
        {hasAgentItems ? (
          <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={thinking} />
        ) : (
          <span
            className={cn(
              "inline-flex h-4 w-4 shrink-0 rounded-full bg-[conic-gradient(from_180deg,#f59e0b,#f97316,#22c55e,#0ea5e9,#f59e0b)]",
              thinking ? "think-summary-active" : ""
            )}
          />
        )}
        <span className="text-[0.92rem] font-medium text-muted-foreground">
          {summaryLabel}
          {durationLabel}
        </span>
      </button>

      <div
        className={cn(
          "transition-all duration-200 ease-out",
          expanded ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0",
          !thinking && expanded ? "max-h-[65vh]" : ""
        )}
      >
        <div className={containerClassName}>
          {!thinking && expanded && hasAgentItems ? (
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={false} />
                <h4 className="text-[0.95rem] font-medium text-foreground">思考结果</h4>
              </div>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                onClick={() => setExpanded(false)}
                aria-label="关闭思考结果"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : null}
          {displayTimeline.length > 0 ? (
            <div className="space-y-3">
              {displayTimeline.map((entry, index) => {
                if (entry.kind === "websearch") {
                  return (
                    <div key={entry.key} className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                          {entry.visited ? <Globe className="size-5" /> : <Search className="size-5" />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[0.95rem] text-muted-foreground">
                            {entry.visited ? "已浏览" : "已搜索的网络"}
                          </p>
                          <p
                            className={cn(
                              thinking
                                ? "break-all text-[0.95rem] leading-6 text-foreground"
                                : "break-all text-base leading-8 text-foreground",
                              entry.visited ? "italic" : ""
                            )}
                          >
                            {formatSearchTextForDisplay(entry.text)}
                          </p>
                        </div>
                      </div>
                      {typeof entry.resultsCount === "number" ? (
                        <span className="shrink-0 pt-1 text-[0.95rem] text-muted-foreground">
                          {entry.resultsCount} 结果
                        </span>
                      ) : null}
                    </div>
                  )
                }

                if (entry.kind === "agent") {
                  const active = thinking && entry.agentKey === activeAgentKey
                  const isPrimaryAgent = entry.agentKey === "grok_primary"
                  return (
                    <div key={entry.key} className="space-y-2.5">
                      <div className="flex items-center gap-2 pl-0.5 text-[0.95rem] font-semibold text-foreground">
                        {isPrimaryAgent ? (
                          <AgentCanvasOrb paletteIndex={0} isPrimary={true} active={active} thinking={thinking} size="lg" />
                        ) : (
                          <AgentIconOrb
                            paletteIndex={entry.paletteIndex}
                            active={active}
                            thinking={thinking}
                            size="lg"
                          />
                        )}
                        <span>{entry.agentLabel}</span>
                        <ChevronDown className="size-4 text-muted-foreground" />
                      </div>
                      <p
                        className={cn(
                          "ml-11 whitespace-pre-wrap break-words text-[0.92rem] leading-6 text-foreground/95",
                          thinking
                            ? "[display:-webkit-box] [-webkit-line-clamp:4] [-webkit-box-orient:vertical] overflow-hidden"
                            : ""
                        )}
                      >
                        {entry.body || "（空）"}
                      </p>
                    </div>
                  )
                }

                return (
                  <div key={entry.key} className="space-y-1">
                    <p className="text-[0.9rem] font-medium text-muted-foreground">{entry.label}</p>
                    {entry.body.trim() ? (
                      <p className="whitespace-pre-wrap text-[0.95rem] leading-7 text-foreground/95">
                        {entry.body}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : thinking ? (
            <div className="space-y-2 pt-1">
              <div className="h-3 w-2/5 animate-pulse rounded bg-secondary/70" />
              <div className="h-5 w-full animate-pulse rounded bg-secondary/60" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-secondary/60" />
            </div>
          ) : (
            <MarkdownBody content={normalized || "（空）"} />
          )}
        </div>
      </div>
    </div>
  )
}

export function MarkdownContent({
  content,
  streaming = false,
  reasoningEvents = [],
  reasoningActive = false,
}: {
  content: string
  streaming?: boolean
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningActive?: boolean
}) {
  const parsed = useMemo(() => extractAssistantToolMeta(content), [content])
  const liveCards = useMemo(() => collectCardsFromReasoningEvents(reasoningEvents), [reasoningEvents])
  const mergedCards = useMemo(
    () => ({
      ...parsed.meta.cards,
      ...liveCards,
    }),
    [liveCards, parsed.meta.cards]
  )
  const expandedContent = useMemo(
    () => expandGrokRenderTags(parsed.content, mergedCards),
    [mergedCards, parsed.content]
  )



  const hasStructuredReasoning = reasoningEvents.length > 0
  const shouldShowStructuredReasoning = hasStructuredReasoning
  const shouldRenderLegacyThink = !hasStructuredReasoning
  const sections = useMemo(
    () =>
      parseThinkSections(expandedContent, {
        treatUnclosedThinkAsThinking: streaming,
      }),
    [expandedContent, streaming]
  )
  const visibleSections = useMemo(
    () =>
      sections.filter((section) => {
        if (section.type === "text") {
          return true
        }
        return shouldRenderLegacyThink
      }),
    [sections, shouldRenderLegacyThink]
  )

  if (!shouldShowStructuredReasoning && visibleSections.length === 0) {
    return null
  }

  return (
    <div className="space-y-1 text-foreground">
      {shouldShowStructuredReasoning ? (
        <StructuredReasoningPanel events={reasoningEvents} isThinking={reasoningActive} />
      ) : null}
      {visibleSections.map((section, index) => {
        if (section.type === "think") {
          return (
            <ThinkBlock
              key={`think-${index}`}
              content={section.value}
              open={section.open}
              thinking={section.thinking}
              toolMeta={{
                webSearch: parsed.meta.webSearch,
                cards: mergedCards,
              }}
            />
          )
        }
        return <MarkdownBody key={`text-${index}`} content={section.value} streaming={streaming} />
      })}
    </div>
  )
}
