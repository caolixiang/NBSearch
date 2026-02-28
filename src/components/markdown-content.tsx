"use client"

import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { ChevronDown, ChevronRight, Globe, Search, X } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "@/domain/chat/types"
import { cn } from "@/lib/utils"
import { GrokLogo } from "./claude-logo"
import { GrokLottieIcon, HoverAnimationProvider, type GrokLottieName } from "./grok-lottie"

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
  ["#2f54eb", "#0ea5e9", "#7c3aed", "#22d3ee"],
  ["#facc15", "#f59e0b", "#b45309", "#dc2626"],
  ["#a855f7", "#d946ef", "#7e22ce", "#ec4899"],
  ["#84cc16", "#facc15", "#ea580c", "#d97706"],
] as const

const AGENT_STACK_RING_COLORS = ["#9ca3af", "#22c55e", "#f97316", "#60a5fa", "#a855f7", "#eab308"] as const

const AGENT_STACK_ICON_SEQUENCE: GrokLottieName[] = [
  "waveform",
  "square_pen",
  "square_code",
  "search",
  "folder",
  "image",
  "pin",
  "rewind",
]

function resolveAgentIconName(paletteIndex: number): GrokLottieName {
  return AGENT_STACK_ICON_SEQUENCE[Math.abs(paletteIndex) % AGENT_STACK_ICON_SEQUENCE.length] || "search"
}

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
  return `<${url.trim()}>`
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
  if (!content.trim()) {
    return ""
  }

  return content.replace(/<grok:render\b[^>]*card_id="([^"]+)"[^>]*>[\s\S]*?<\/grok:render>/gi, (_, cardId) => {
    const normalizedCardId = typeof cardId === "string" ? cardId.trim() : ""
    const card = normalizedCardId ? cards[normalizedCardId] : undefined
    const imageUrl = card?.image?.original || card?.image?.thumbnail || card?.url
    if (!imageUrl) {
      return ""
    }

    const alt = escapeMarkdownText(card?.image?.title || card?.image?.source || "Generated Image") || "Generated Image"
    const imageMarkdown = `![${alt}](${wrapMarkdownUrl(imageUrl)})`
    const targetUrl = card?.image?.link || card?.url
    return targetUrl ? `[${imageMarkdown}](${wrapMarkdownUrl(targetUrl)})` : imageMarkdown
  })
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

export function normalizeAssistantMarkdown(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content.replace(/\r\n?/g, "\n")
  normalized = normalized.replace(/<tool-meta>[\s\S]*?<\/tool-meta>/gi, "")
  normalized = normalized.replace(/<grok:render\b[\s\S]*?<\/grok:render>/gi, "")
  normalized = normalized.replace(/<argument\b[\s\S]*?<\/argument>/gi, "")
  normalized = normalized.replace(/<\/think>/gi, "")
  normalized = mergeConsecutiveImageLines(normalized)
  normalized = normalized.replace(/([^\n])(?=#{1,6}\s?)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/(^|\n)(#{1,6}\s[^\n-]+)-\s?/g, "$1$2\n- ")
  normalized = normalized.replace(/([\u4E00-\u9FFF）)])-(?=[\u4E00-\u9FFF0-9A-Za-z])/g, "$1\n- ")
  normalized = normalized.replace(/([^\n])(?=\d+\.\s)/g, "$1\n")
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

  for (const key of ["query", "q", "url", "keyword"]) {
    for (const row of readStringListFromUnknown(args[key])) {
      append(row)
    }
  }

  for (const key of ["queries", "q", "urls", "keywords"]) {
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

function humanizeToolName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return "tool"
  }
  if (trimmed.includes("search")) {
    return "已搜索网络"
  }
  return trimmed.replace(/[_-]+/g, " ")
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

function AgentPixelAvatar({
  paletteIndex,
  active,
  size = "md",
}: {
  paletteIndex: number
  active: boolean
  size?: "sm" | "md" | "lg"
}) {
  const palette = AGENT_PIXEL_PALETTES[Math.abs(paletteIndex) % AGENT_PIXEL_PALETTES.length] as readonly string[]
  const [p0, p1, p2, p3] = palette
  const cellSize: string = size === "sm" ? "2px" : "2.5px"
  const mosaicStyle = {
    backgroundImage: `
      repeating-linear-gradient(0deg, ${p0} 0 ${cellSize}, ${p1} ${cellSize} calc(${cellSize} * 2), ${p2} calc(${cellSize} * 2) calc(${cellSize} * 3), ${p3} calc(${cellSize} * 3) calc(${cellSize} * 4)),
      repeating-linear-gradient(90deg, ${p3} 0 ${cellSize}, ${p2} ${cellSize} calc(${cellSize} * 2), ${p1} calc(${cellSize} * 2) calc(${cellSize} * 3), ${p0} calc(${cellSize} * 3) calc(${cellSize} * 4))
    `,
    backgroundBlendMode: "multiply",
  } as const

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        size === "sm" ? "size-6" : size === "lg" ? "size-9" : "size-7",
        active ? "ring-2 ring-foreground/20 ring-offset-2 ring-offset-background" : ""
      )}
      aria-hidden="true"
    >
      <span className="absolute inset-0 rounded-full border border-black/15 bg-white/75" />
      <span style={mosaicStyle} className="absolute inset-[1.25px] rounded-full [image-rendering:pixelated]" />
      <span className="absolute inset-[1.25px] rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28)]" />
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
  const iconName = resolveAgentIconName(paletteIndex)
  const iconSize = size === "sm" ? 14 : 16
  const shellStyle = {
    animationDelay: `${animationDelayMs}ms`,
    backgroundColor: ringColor,
  } as const

  return (
    <HoverAnimationProvider value={{ isHovering: thinking && active }}>
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full",
          size === "sm" ? "size-7" : size === "lg" ? "size-9" : "size-8",
          active ? "ring-2 ring-foreground/18 ring-offset-2 ring-offset-background" : ""
        )}
        aria-hidden="true"
      >
        {active ? <span className="absolute -inset-[2.5px] rounded-full think-agent-active-halo" /> : null}
        <span style={shellStyle} className={cn("absolute inset-0 rounded-full", thinking ? "think-agent-orb-shell" : "")} />
        <span className="absolute inset-[1.4px] rounded-full bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.24)]" />
        <span
          className={cn(
            "relative z-[1] inline-flex items-center justify-center text-white",
            active ? "think-grok-orb" : ""
          )}
        >
          <GrokLottieIcon name={iconName} size={iconSize} className="opacity-95" />
        </span>
      </span>
    </HoverAnimationProvider>
  )
}

function GrokPrimaryOrb({ active, thinking }: { active: boolean; thinking: boolean }) {
  return (
    <HoverAnimationProvider value={{ isHovering: active && thinking }}>
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full",
          active ? "ring-2 ring-foreground/18 ring-offset-2 ring-offset-background" : ""
        )}
        aria-hidden="true"
      >
        {active ? <span className="absolute -inset-[2.5px] rounded-full think-agent-active-halo" /> : null}
        <span className={cn("absolute inset-0 rounded-full bg-[#9ca3af]", thinking ? "think-agent-orb-shell" : "")} />
        <span className="absolute inset-[1.4px] rounded-full border border-white/20 bg-black" />
        <span className={cn("relative z-[1] inline-flex items-center justify-center text-white", active ? "think-grok-orb" : "")}>
          <GrokLogo className="size-3.5" />
        </span>
      </span>
    </HoverAnimationProvider>
  )
}

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
          <GrokPrimaryOrb key={agent.key} active={agent.key === activeAgentKey} thinking={thinking} />
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
  const agents = useMemo(() => collectRolloutAgents(summary.rolloutIds), [summary.rolloutIds])
  const agentByKey = useMemo(() => {
    const map = new Map<string, AgentDescriptor>()
    for (const agent of agents) {
      map.set(agent.key, agent)
    }
    return map
  }, [agents])
  const [activeTick, setActiveTick] = useState(0)
  const [expanded, setExpanded] = useState(isThinking)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const startedAtRef = useRef<number | null>(isThinking ? Date.now() : null)
  const previousThinkingRef = useRef(isThinking)
  const displayEntries = useMemo(
    () => (isThinking ? summary.entries.slice(-3) : summary.entries),
    [isThinking, summary.entries]
  )

  const activeAgentKey = useMemo(() => {
    for (let index = summary.entries.length - 1; index >= 0; index -= 1) {
      const entry = summary.entries[index]
      if (!entry) {
        continue
      }
      if (entry.status === "running") {
        return toAgentKey(entry.rolloutId)
      }
    }
    if (agents.length > 0) {
      return agents[activeTick % agents.length]?.key || "grok_primary"
    }
    return "grok_primary"
  }, [activeTick, agents, summary.entries])

  useEffect(() => {
    if (isThinking) {
      if (!startedAtRef.current) {
        startedAtRef.current = Date.now()
      }
      setExpanded(true)
    } else if (startedAtRef.current) {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
    }

    if (previousThinkingRef.current && !isThinking) {
      setExpanded(false)
    }
    previousThinkingRef.current = isThinking
  }, [isThinking])

  useEffect(() => {
    if (!isThinking || agents.length <= 1) {
      return
    }
    const timer = window.setInterval(() => {
      setActiveTick((value) => value + 1)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, isThinking])

  useEffect(() => {
    if (!isThinking || !startedAtRef.current) {
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
  }, [isThinking])

  const summaryLabel = isThinking ? "思考中" : "思考过程"
  const durationLabel = durationSeconds > 0 || isThinking ? ` · ${durationSeconds || 0}s` : ""

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-2 text-muted-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/85 transition-transform duration-200",
            expanded ? "rotate-90" : ""
          )}
        />
        <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={isThinking} />
        <span className={cn("text-[0.95rem] font-medium", isThinking ? "text-foreground/80" : "text-muted-foreground")}>
          {summaryLabel}
          {durationLabel}
        </span>
      </button>
      <div
        className={cn(
          "transition-all duration-200 ease-out",
          expanded ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0"
        )}
      >
        <div className={cn(isThinking ? "relative min-h-[14rem] overflow-hidden" : "max-h-[65vh] overflow-auto pr-2")}>
          {displayEntries.length > 0 ? (
            <div className={cn(isThinking ? "flex min-h-[14rem] flex-col justify-end space-y-3" : "space-y-3")}>
              {displayEntries.map((entry, index) => {
                const active =
                  isThinking && entry.status === "running" && toAgentKey(entry.rolloutId) === activeAgentKey
                const entryAgentKey = toAgentKey(entry.rolloutId)
                const descriptor = agentByKey.get(entryAgentKey) || resolveAgentDescriptorByKey(agents, entryAgentKey)
                const key = `${entry.key}:${index}`
                const ageFromNewest = displayEntries.length - 1 - index
                return (
                  <div
                    key={key}
                    className={cn(
                      "flex items-start justify-between gap-4",
                      isThinking ? "animate-in slide-in-from-bottom-2 duration-300 fade-in-50 think-stream-row" : "",
                      isThinking && ageFromNewest >= 2
                        ? "think-stream-row-oldest"
                        : isThinking && ageFromNewest === 1
                          ? "think-stream-row-middle"
                          : isThinking
                            ? "think-stream-row-newest"
                            : "",
                      active ? "think-stream-row-active" : ""
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className="mt-0.5 inline-flex shrink-0 items-center justify-center">
                        {descriptor.isPrimary ? (
                          <GrokPrimaryOrb active={active} thinking={isThinking} />
                        ) : (
                          <AgentIconOrb
                            paletteIndex={descriptor.paletteIndex}
                            active={active}
                            thinking={isThinking}
                            size="sm"
                            animationDelayMs={index * 110}
                          />
                        )}
                      </span>
                      <span className="mt-1 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                        {entry.visited ? <Globe className="size-5" /> : <Search className="size-5" />}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[0.9rem] text-muted-foreground">
                          {descriptor.label} · {entry.visited ? "已浏览网页" : "已经搜索网络"}
                        </p>
                        <p
                          className={cn(
                            "break-all text-[0.98rem] leading-7 text-foreground",
                            entry.visited ? "italic" : ""
                          )}
                        >
                          {entry.text}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      {typeof entry.resultsCount === "number" ? (
                        <span className="text-[0.88rem] text-muted-foreground">{entry.resultsCount} 结果</span>
                      ) : null}
                      {active ? <span className="size-1.5 animate-pulse rounded-full bg-foreground/60" /> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : isThinking ? (
            <div className="space-y-2 pt-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-secondary/70" />
              <div className="h-5 w-full animate-pulse rounded bg-secondary/60" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-secondary/60" />
            </div>
          ) : (
            <p className="pt-2 text-[0.9rem] text-muted-foreground">暂无思考记录</p>
          )}
          {isThinking ? (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background via-background/88 to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/84 to-transparent" />
            </>
          ) : null}
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

function MarkdownBody({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  if (!normalized) {
    return null
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
        p: ({ children }) => {
          const nodes = Children.toArray(children).filter(
            (item) => !(typeof item === "string" && item.trim() === "")
          )
          const imageOnlyParagraph = nodes.length > 0 && nodes.every((item) => isImageNode(item))

          if (!imageOnlyParagraph) {
            return <p className="leading-7">{children}</p>
          }

          if (nodes.length === 1) {
            return (
              <div className="my-2 inline-block w-full align-top sm:w-[calc(50%-0.375rem)] sm:pr-1.5">
                <div className="overflow-hidden rounded-xl border border-border bg-secondary/20">{nodes[0]}</div>
              </div>
            )
          }

          return (
            <div className="my-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {nodes.map((node, index) => (
                <div key={index} className="overflow-hidden rounded-xl border border-border bg-secondary/20">
                  {node}
                </div>
              ))}
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
        img: ({ src, alt }) => (
          <img
            src={src || ""}
            alt={alt || ""}
            loading="lazy"
            className="h-auto max-h-[380px] w-full rounded-xl border border-border bg-secondary/20 object-contain"
          />
        ),
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
    </ReactMarkdown>
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

  useEffect(() => {
    if (thinking) {
      if (!startedAtRef.current) {
        startedAtRef.current = Date.now()
      }
      setExpanded(true)
    } else if (startedAtRef.current) {
      const elapsed = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
    }

    if (previousThinkingRef.current && !thinking) {
      // Collapse immediately once </think> appears; user can expand manually if needed.
      setExpanded(false)
    }
    previousThinkingRef.current = thinking
  }, [thinking])

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
        <span className="text-[2rem] font-semibold tracking-tight text-muted-foreground">
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
                <h4 className="text-[2rem] font-semibold tracking-tight text-foreground">思考结果</h4>
              </div>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                onClick={() => setExpanded(false)}
                aria-label="关闭思考结果"
              >
                <X className="size-6" />
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
                            {entry.text}
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
                          <GrokPrimaryOrb active={active} thinking={thinking} />
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
                      <div className="ml-11 rounded-3xl border border-border bg-background/75 px-5 py-4">
                        <p
                          className={cn(
                            "whitespace-pre-wrap break-words text-[1.02rem] leading-8 text-foreground/95",
                            thinking
                              ? "[display:-webkit-box] [-webkit-line-clamp:4] [-webkit-box-orient:vertical] overflow-hidden"
                              : ""
                          )}
                        >
                          {entry.body || "（空）"}
                        </p>
                      </div>
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
        return <MarkdownBody key={`text-${index}`} content={section.value} />
      })}
    </div>
  )
}
