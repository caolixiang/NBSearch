import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import type { AgentDescriptor, StructuredReasoningEntry, StructuredReasoningSummary } from "./types"
import { AGENT_PIXEL_PALETTES } from "./types"
import { isLikelyUrl, parseAgentMeta } from "./think-parser"

export type AgentGroupedEntries = {
  agent: AgentDescriptor
  entries: StructuredReasoningEntry[]
}

function normalizeRolloutId(value: string | undefined): string {
  let trimmed = (value || "").trim()
  // Strip upstream "Chat Room" prefix (e.g., "Chat Room Grok" → "Grok")
  trimmed = trimmed.replace(/^Chat\s*Room\s*/i, "").trim()
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

export function isImageSearchToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.includes("search_image") || normalized.includes("imagesearch") || normalized.includes("image_search")
}

export function isXSearchToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith("x_") || normalized.includes("xsearch")
}

export function isChatroomSendToolName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === "chatroom_send" || normalized === "chatroomsend"
}

export function humanizeToolName(value: string): string {
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

export function resolveStructuredEntryLabel(toolName: string, visited: boolean, status?: string): string {
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

export function buildStructuredReasoningSummary(events: ChatReasoningEventDetail[]): StructuredReasoningSummary {
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

      // chatroom_send is agent thinking — extract 'message' arg
      if (isChatroomSendToolName(detail.usage.toolName)) {
        const message =
          typeof detail.usage.args.message === "string" ? detail.usage.args.message.trim() : ""
        if (message) {
          const key = `${detail.usage.toolUsageCardId}:chatroom`
          if (!entryByKey.has(key)) {
            const nextEntry: StructuredReasoningEntry = {
              key,
              toolUsageCardId: detail.usage.toolUsageCardId,
              rolloutId: normalizeRolloutId(detail.usage.rolloutId),
              text: message,
              visited: false,
              toolName: detail.usage.toolName,
              status: "running",
            }
            entryByKey.set(key, nextEntry)
            entryByToolUsageCardId.set(detail.usage.toolUsageCardId, [nextEntry])
            entries.push(nextEntry)
          }
        }
        continue
      }

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

function normalizeRolloutLabel(rolloutId: string): string {
  let label = rolloutId.trim()
  // Strip common upstream prefixes like "Chat Room Grok"
  label = label.replace(/^Chat\s*Room\s*/i, "").trim()
  return label || "Grok"
}

export function collectRolloutAgents(rolloutIds: string[]): AgentDescriptor[] {
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
    const normalized = normalizeRolloutLabel(rolloutId)
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

export function groupEntriesByAgent(
  entries: StructuredReasoningEntry[],
  agents: AgentDescriptor[]
): AgentGroupedEntries[] {
  const result: AgentGroupedEntries[] = []
  let currentKey = ""
  let currentGroup: StructuredReasoningEntry[] = []

  const resolveAgent = (key: string): AgentDescriptor =>
    agents.find((a) => a.key === key) || {
      key,
      label: key === "grok_primary" ? "Grok" : key.replace(/_/g, " "),
      paletteIndex: 0,
    }

  const flush = () => {
    if (currentKey && currentGroup.length > 0) {
      result.push({ agent: resolveAgent(currentKey), entries: currentGroup })
    }
    currentGroup = []
  }

  for (const entry of entries) {
    const key = toAgentKey(entry.rolloutId)
    if (key !== currentKey) {
      flush()
      currentKey = key
    }
    currentGroup.push(entry)
  }
  flush()

  return result
}

export function toAgentKey(rolloutId: string): string {
  let normalized = rolloutId.trim().toLowerCase()
  // Strip upstream "Chat Room" prefix
  normalized = normalized.replace(/^chat\s*room\s*/i, "").trim()
  if (!normalized || normalized === "grok") {
    return "grok_primary"
  }
  return normalized.replace(/\s+/g, "_")
}

export function resolveAgentDescriptorByKey(agents: AgentDescriptor[], key: string): AgentDescriptor {
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
