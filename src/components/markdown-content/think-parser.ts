import type {
  AgentDescriptor,
  AssistantToolMeta,
  MarkdownSection,
  ThinkItem,
  ThinkSection,
  ThinkTimelineEntry,
} from "./types"
import { AGENT_PIXEL_PALETTES } from "./types"

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

export function parseThinkItems(content: string): ThinkItem[] {
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

export function isWebSearchThinkItemType(type: string): boolean {
  const key = type.trim().toLowerCase().replace(/\s+/g, "")
  return key.includes("websearch")
}

export function isAgentThinkItemType(type: string): boolean {
  const normalized = type.trim().toLowerCase()
  return /^agent\s*\d*$/i.test(type.trim()) || normalized === "grok"
}

export function isAgentThinkContainerType(type: string): boolean {
  const normalized = type.trim().toLowerCase().replace(/[\s_-]+/g, "")
  return normalized === "agentthink" || normalized === "agentthought" || normalized === "multiagent"
}

export function isLikelyUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}(?:\/|$))/i.test(text)
}

export function decodeUrlForDisplay(value: string): string {
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

export function formatSearchTextForDisplay(value: string): string {
  if (!isLikelyUrl(value)) {
    return value
  }
  return decodeUrlForDisplay(value)
}

export function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
}

export function isEmptyThinkBody(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return true
  }
  return /^(?:\(空\)|（空）|\[空\]|空|none|null|n\/a|na|-)$/i.test(text)
}

export function parseAgentMeta(type: string, fallbackIndex: number): AgentDescriptor | null {
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

export function extractNestedAgentEntries(body: string): Array<{ label: string; body: string }> {
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

export function collectAgentDescriptors(items: ThinkItem[]): AgentDescriptor[] {
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

export function buildThinkTimeline(items: ThinkItem[], toolMeta: AssistantToolMeta): ThinkTimelineEntry[] {
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

export function findLatestAgentKey(timeline: ThinkTimelineEntry[]): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const current = timeline[index]
    if (current?.kind === "agent") {
      return current.agentKey
    }
  }
  return "grok_primary"
}
