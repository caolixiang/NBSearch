import type {
  ChatDeepSearchResearch,
  ChatDeepSearchDetail,
  ChatDeepSearchResearchStep,
  ChatReasoningEventDetail,
} from "@/domain/chat/types"
import type {
  AgentDescriptor,
  StructuredReasoningEntry,
  StructuredReasoningSummary,
  StructuredReasoningToolChainItem,
} from "./types"
import { AGENT_PIXEL_PALETTES } from "./types"
import { isLikelyUrl, parseAgentMeta } from "./think-parser"

export type AgentGroupedEntries = {
  agent: AgentDescriptor
  entries: StructuredReasoningEntry[]
}

export type DeepSearchGroupedItem =
  | {
      kind: "summary"
      key: string
      rows: string[]
    }
  | {
      kind: "tool"
      key: string
      entries: StructuredReasoningEntry[]
    }

export type DeepSearchGroupedSection = {
  key: string
  title: string
  items: DeepSearchGroupedItem[]
}

export type DeepSearchTimelineItem =
  | {
      kind: "thought"
      key: string
      title: string
      bullets: string[]
    }
  | {
      kind: "tool"
      key: string
      entry: StructuredReasoningEntry
    }

export function hasDeepSearchContent(research: Pick<ChatDeepSearchResearch, "steps" | "details"> | undefined): boolean {
  if (!research) {
    return false
  }
  const steps = Array.isArray(research.steps) ? research.steps : []
  const details = Array.isArray(research.details) ? research.details : []
  return steps.length > 0 || details.length > 0
}

export function shouldShowResearchDetails(hasAgentItems: boolean, timelineCount: number): boolean {
  return !hasAgentItems && timelineCount === 0
}

export function mergeReasoningRolloutIds(
  summaryRolloutIds: string[],
  research: Pick<ChatDeepSearchResearch, "uiLayout"> | undefined
): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  const append = (value: string | undefined) => {
    const normalized = normalizeRolloutId(value)
    if (seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    merged.push(normalized)
  }

  for (const rolloutId of summaryRolloutIds) {
    append(rolloutId)
  }

  const rolloutIds = Array.isArray(research?.uiLayout?.rolloutIds) ? research.uiLayout.rolloutIds : []
  for (const rolloutId of rolloutIds) {
    append(typeof rolloutId === "string" ? rolloutId : undefined)
  }

  if (merged.length === 0) {
    merged.push("Grok")
  }

  return merged
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
  const toolUsageCardToName = new Map<string, string>()
  const toolUsageCounts = new Map<string, number>()
  const toolCompletedCounts = new Map<string, number>()
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
      if (detail.usage.toolUsageCardId) {
        toolUsageCardToName.set(detail.usage.toolUsageCardId, detail.usage.toolName)
      }
      if (!isChatroomSendToolName(detail.usage.toolName)) {
        const currentUsageCount = toolUsageCounts.get(detail.usage.toolName) || 0
        toolUsageCounts.set(detail.usage.toolName, currentUsageCount + 1)
      }

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
      const completedToolName = toolUsageCardToName.get(toolUsageCardId)
      if (completedToolName && !isChatroomSendToolName(completedToolName)) {
        const currentCompletedCount = toolCompletedCounts.get(completedToolName) || 0
        toolCompletedCounts.set(completedToolName, currentCompletedCount + 1)
      }

      const scopedEntries = entryByToolUsageCardId.get(toolUsageCardId)
      if (scopedEntries && scopedEntries.length > 0) {
        scopedEntries.forEach((entry) => {
          entry.status = "completed"
          if (typeof detail.result.webSearchResultsCount === "number") {
            entry.resultsCount = detail.result.webSearchResultsCount
          }
          if (Array.isArray(detail.result.webSearchResults)) {
            entry.webSearchResults = detail.result.webSearchResults
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
        webSearchResults: Array.isArray(detail.result.webSearchResults) ? detail.result.webSearchResults : undefined,
      }
      entryByKey.set(fallbackKey, fallbackEntry)
      entryByToolUsageCardId.set(toolUsageCardId, [fallbackEntry])
      entries.push(fallbackEntry)
    }
  }

  if (rolloutIds.length === 0) {
    rolloutIds.push("Grok")
  }

  const toolChain: StructuredReasoningToolChainItem[] = []
  for (const [toolName, usageCount] of toolUsageCounts) {
    const completedCount = Math.min(toolCompletedCounts.get(toolName) || 0, usageCount)
    toolChain.push({
      toolName,
      usageCount,
      completedCount,
      runningCount: Math.max(0, usageCount - completedCount),
    })
  }
  toolChain.sort((a, b) => {
    if (b.usageCount !== a.usageCount) {
      return b.usageCount - a.usageCount
    }
    return a.toolName.localeCompare(b.toolName)
  })

  return {
    entries,
    rolloutIds,
    toolChain,
  }
}

export function buildDeepSearchGroupedSections(
  steps: ChatDeepSearchResearchStep[] | undefined,
  entries: StructuredReasoningEntry[]
): DeepSearchGroupedSection[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    return []
  }

  const entriesByToolUsageCardId = new Map<string, StructuredReasoningEntry[]>()
  for (const entry of entries) {
    const cardId = entry.toolUsageCardId.trim()
    if (!cardId) {
      continue
    }
    const scoped = entriesByToolUsageCardId.get(cardId) || []
    scoped.push(entry)
    entriesByToolUsageCardId.set(cardId, scoped)
  }

  const sections: DeepSearchGroupedSection[] = []
  let current: { title: string; items: DeepSearchGroupedItem[] } | null = null
  let sectionIndex = 0
  let itemIndex = 0
  const XML_TOOL_USAGE_ROW_PATTERN = /<xai:tool_usage_card\b/i

  const ensureCurrent = (fallbackTitle = "深度挖掘细节") => {
    if (!current) {
      current = {
        title: fallbackTitle,
        items: [],
      }
    }
  }

  const pushSummaryRows = (rows: string[]) => {
    const normalizedRows = rows
      .flatMap((row) => row.split(/\r?\n/))
      .map((row) => row.trim())
      .filter((row) => Boolean(row) && !XML_TOOL_USAGE_ROW_PATTERN.test(row))
      .map((row) => row.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
    if (normalizedRows.length === 0) {
      return
    }
    ensureCurrent()
    current!.items.push({
      kind: "summary",
      key: `summary_${itemIndex++}`,
      rows: normalizedRows,
    })
  }

  const flush = () => {
    if (!current || current.items.length === 0) {
      current = null
      return
    }
    sections.push({
      key: `section_${sectionIndex++}`,
      title: current.title || "深度挖掘细节",
      items: current.items,
    })
    current = null
  }

  const createSyntheticEntry = (
    usage: NonNullable<ChatDeepSearchResearchStep["toolUsages"]>[number],
    fallbackKeyPrefix: string
  ): StructuredReasoningEntry => {
    const candidates = readToolUsageQueries(usage.args || {})
    const text = (candidates[0] || "").trim() || humanizeToolName(usage.toolName || "tool")
    const normalizedToolName = (usage.toolName || "").trim() || "tool"
    const toolUsageCardId = usage.toolUsageCardId.trim()
    return {
      key: `${fallbackKeyPrefix}:${toolUsageCardId}`,
      toolUsageCardId,
      rolloutId: "Grok",
      text,
      visited: isLikelyUrl(text),
      toolName: normalizedToolName,
      resultsCount: Array.isArray(usage.webSearchResults) && usage.webSearchResults.length > 0
        ? usage.webSearchResults.length
        : undefined,
      webSearchResults:
        Array.isArray(usage.webSearchResults) && usage.webSearchResults.length > 0
          ? usage.webSearchResults
          : undefined,
      status: "completed",
    }
  }

  for (const step of steps) {
    const tags = step.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    const hasHeaderTag = tags.includes("header")
    const hasToolUsageCardTag = tags.includes("tool_usage_card")
    const textRows = step.text.map((row) => row.trim()).filter(Boolean)
    const titleCandidate = (step.title || "").trim()
    const toolUsageCardIds = (step.toolUsageCardIds || []).map((id) => id.trim()).filter(Boolean)

    if (hasHeaderTag) {
      flush()
      const nextTitle = titleCandidate || textRows[0] || "深度挖掘细节"
      const remainingRows =
        titleCandidate || textRows.length === 0
          ? textRows
          : textRows.slice(1)
      current = {
        title: nextTitle,
        items: [],
      }
      pushSummaryRows(remainingRows)
      continue
    }

    if (hasToolUsageCardTag || toolUsageCardIds.length > 0 || (step.toolUsages || []).length > 0) {
      ensureCurrent(titleCandidate || "深度挖掘细节")
      const mappedEntries: StructuredReasoningEntry[] = []
      const mappedSeen = new Set<string>()
      const seenToolUsageCardIds = new Set<string>()
      const stepToolUsageById = new Map<string, NonNullable<ChatDeepSearchResearchStep["toolUsages"]>[number]>()
      for (const usage of step.toolUsages || []) {
        const normalizedId = (usage.toolUsageCardId || "").trim()
        if (!normalizedId || stepToolUsageById.has(normalizedId)) {
          continue
        }
        stepToolUsageById.set(normalizedId, usage)
      }

      for (const toolUsageCardId of toolUsageCardIds) {
        seenToolUsageCardIds.add(toolUsageCardId)
        const scopedEntries = entriesByToolUsageCardId.get(toolUsageCardId) || []
        for (const entry of scopedEntries) {
          if (mappedSeen.has(entry.key)) {
            continue
          }
          mappedSeen.add(entry.key)
          mappedEntries.push(entry)
        }
        if (scopedEntries.length === 0) {
          const usage = stepToolUsageById.get(toolUsageCardId)
          if (usage) {
            const fallbackEntry = createSyntheticEntry(usage, `step_${sectionIndex}_${itemIndex}`)
            if (!mappedSeen.has(fallbackEntry.key)) {
              mappedSeen.add(fallbackEntry.key)
              mappedEntries.push(fallbackEntry)
            }
          }
        }
      }

      for (const [toolUsageCardId, usage] of stepToolUsageById.entries()) {
        if (seenToolUsageCardIds.has(toolUsageCardId)) {
          continue
        }
        const fallbackEntry = createSyntheticEntry(usage, `step_${sectionIndex}_${itemIndex}`)
        if (!mappedSeen.has(fallbackEntry.key)) {
          mappedSeen.add(fallbackEntry.key)
          mappedEntries.push(fallbackEntry)
        }
      }

      if (mappedEntries.length > 0) {
        current!.items.push({
          kind: "tool",
          key: `tool_${itemIndex++}`,
          entries: mappedEntries,
        })
      } else {
        pushSummaryRows(textRows)
      }
      continue
    }

    if (titleCandidate && !current) {
      current = {
        title: titleCandidate,
        items: [],
      }
    }
    pushSummaryRows(textRows)
  }

  flush()
  return sections
}

const DEEPSEARCH_XML_ROW_PATTERN = /<\/?xai:[^>]*>/i
const LEGACY_TOOL_USAGE_CARD_ID_XML_PATTERN = /<xai:tool_usage_card_id>([^<]+)<\/xai:tool_usage_card_id>/i
const LEGACY_TOOL_NAME_XML_PATTERN = /<xai:tool_name>([^<]+)<\/xai:tool_name>/i
const LEGACY_TOOL_ARGS_XML_PATTERN = /<xai:tool_args><!\[CDATA\[(.*?)\]\]><\/xai:tool_args>/is

function sanitizeDeepSearchRows(rows: string[]): string[] {
  return rows
    .flatMap((row) => row.split(/\r?\n/))
    .map((row) => row.trim())
    .filter((row) => Boolean(row) && !DEEPSEARCH_XML_ROW_PATTERN.test(row))
    .map((row) => row.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
}

function extractLegacyToolUsageFromXml(
  value: string
): { toolUsageCardId: string; toolName: string; args: Record<string, unknown> } | null {
  const source = value.trim()
  if (!source) {
    return null
  }
  const cardIdMatched = LEGACY_TOOL_USAGE_CARD_ID_XML_PATTERN.exec(source)
  const toolUsageCardId = (cardIdMatched?.[1] || "").trim()
  if (!toolUsageCardId) {
    return null
  }

  const toolNameMatched = LEGACY_TOOL_NAME_XML_PATTERN.exec(source)
  const toolName = (toolNameMatched?.[1] || "").trim() || "tool"
  const argsMatched = LEGACY_TOOL_ARGS_XML_PATTERN.exec(source)
  const argsRaw = (argsMatched?.[1] || "").trim()
  let args: Record<string, unknown> = {}
  if (argsRaw) {
    try {
      const parsed = JSON.parse(argsRaw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      // Keep default empty args for malformed legacy XML blocks.
    }
  }
  return {
    toolUsageCardId,
    toolName,
    args,
  }
}

function createSyntheticTimelineToolEntry(
  usage: NonNullable<ChatDeepSearchResearchStep["toolUsages"]>[number],
  keyPrefix: string
): StructuredReasoningEntry {
  const textCandidates = readToolUsageQueries(usage.args || {})
  const text = (textCandidates[0] || "").trim() || humanizeToolName(usage.toolName || "tool")
  const toolUsageCardId = usage.toolUsageCardId.trim()
  const resultsCountFromArgs = readRequestedResultsCount(usage.args || {})
  const resultsCountFromRows = Array.isArray(usage.webSearchResults) ? usage.webSearchResults.length : undefined
  return {
    key: `${keyPrefix}:${toolUsageCardId}`,
    toolUsageCardId,
    rolloutId: "Grok",
    text,
    visited: isLikelyUrl(text),
    toolName: (usage.toolName || "").trim() || "tool",
    status: "completed",
    resultsCount:
      typeof resultsCountFromRows === "number" && resultsCountFromRows > 0
        ? resultsCountFromRows
        : resultsCountFromArgs,
    webSearchResults:
      Array.isArray(usage.webSearchResults) && usage.webSearchResults.length > 0
        ? usage.webSearchResults
        : undefined,
  }
}

export function buildDeepSearchTimeline(
  steps: ChatDeepSearchResearchStep[] | undefined,
  entries: StructuredReasoningEntry[]
): DeepSearchTimelineItem[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    return []
  }

  const entriesByToolUsageCardId = new Map<string, StructuredReasoningEntry[]>()
  for (const entry of entries) {
    const key = entry.toolUsageCardId.trim()
    if (!key) {
      continue
    }
    const scoped = entriesByToolUsageCardId.get(key) || []
    scoped.push(entry)
    entriesByToolUsageCardId.set(key, scoped)
  }

  const timeline: DeepSearchTimelineItem[] = []
  let thoughtIndex = 0
  let toolIndex = 0
  let currentThought: { title: string; bullets: string[] } | null = null

  const flushThought = () => {
    if (!currentThought) {
      return
    }
    const title = currentThought.title.trim() || "思考过程"
    const bullets = currentThought.bullets.map((row) => row.trim()).filter(Boolean)
    timeline.push({
      kind: "thought",
      key: `deepsearch_thought_${thoughtIndex++}`,
      title,
      bullets,
    })
    currentThought = null
  }

  for (const step of steps) {
    const tags = step.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    const hasHeaderTag = tags.includes("header")
    const hasSummaryTag = tags.includes("summary")
    const hasToolUsageTag = tags.includes("tool_usage_card")
    const titleCandidate = (step.title || "").trim()
    const rows = sanitizeDeepSearchRows(step.text)
    const stepToolUsages = (step.toolUsages || []).filter((usage) => (usage.toolUsageCardId || "").trim())
    const stepToolUsageIds = Array.from(
      new Set([
        ...(step.toolUsageCardIds || []).map((id) => id.trim()).filter(Boolean),
        ...stepToolUsages.map((usage) => usage.toolUsageCardId.trim()),
      ])
    )

    if (hasHeaderTag) {
      flushThought()
      const nextTitle = titleCandidate || rows[0] || "思考过程"
      const remainingRows = titleCandidate ? rows : rows.slice(1)
      currentThought = {
        title: nextTitle,
        bullets: remainingRows,
      }
      continue
    }

    if (hasSummaryTag) {
      if (!currentThought) {
        currentThought = {
          title: titleCandidate || "思考过程",
          bullets: [],
        }
      }
      currentThought.bullets.push(...rows)
      continue
    }

    if (hasToolUsageTag || stepToolUsageIds.length > 0 || stepToolUsages.length > 0) {
      flushThought()
      const usageById = new Map<string, NonNullable<ChatDeepSearchResearchStep["toolUsages"]>[number]>()
      for (const usage of stepToolUsages) {
        const key = usage.toolUsageCardId.trim()
        if (!key || usageById.has(key)) {
          continue
        }
        usageById.set(key, usage)
      }

      const renderedToolUsageIds = new Set<string>()
      const appendToolEntry = (entry: StructuredReasoningEntry, usageId: string) => {
        timeline.push({
          kind: "tool",
          key: `deepsearch_tool_${toolIndex++}`,
          entry: {
            ...entry,
            status: entry.status || "completed",
          },
        })
        renderedToolUsageIds.add(usageId)
      }

      for (const toolUsageCardId of stepToolUsageIds) {
        const mappedEntries = entriesByToolUsageCardId.get(toolUsageCardId) || []
        if (mappedEntries.length > 0) {
          for (const mappedEntry of mappedEntries) {
            appendToolEntry(mappedEntry, toolUsageCardId)
          }
          continue
        }

        const usage = usageById.get(toolUsageCardId)
        if (usage) {
          appendToolEntry(createSyntheticTimelineToolEntry(usage, `deepsearch_step_${toolIndex}`), toolUsageCardId)
        }
      }

      for (const usage of stepToolUsages) {
        const key = usage.toolUsageCardId.trim()
        if (!key || renderedToolUsageIds.has(key)) {
          continue
        }
        appendToolEntry(createSyntheticTimelineToolEntry(usage, `deepsearch_step_${toolIndex}`), key)
      }
      continue
    }

    if (rows.length > 0 || titleCandidate) {
      if (!currentThought) {
        const nextTitle = titleCandidate || rows[0] || "思考过程"
        const remainingRows = titleCandidate ? rows : rows.slice(1)
        currentThought = {
          title: nextTitle,
          bullets: remainingRows,
        }
      } else {
        currentThought.bullets.push(...rows)
      }
    }
  }

  flushThought()
  return timeline
}

export function buildDeepSearchLegacyTimeline(
  details: ChatDeepSearchDetail[] | undefined,
  entries: StructuredReasoningEntry[]
): DeepSearchTimelineItem[] {
  const normalizedDetails = Array.isArray(details) ? details : []
  if (normalizedDetails.length === 0 && entries.length === 0) {
    return []
  }

  const timeline: DeepSearchTimelineItem[] = []
  const thoughtItems: Array<{ title: string; bullets: string[] }> = []
  const legacyToolUsageByCardId = new Map<string, { toolName: string; args: Record<string, unknown> }>()

  for (const detail of normalizedDetails) {
    const rawTitle = (detail.title || "").trim()
    const legacyToolUsage = extractLegacyToolUsageFromXml(rawTitle)
    if (legacyToolUsage) {
      legacyToolUsageByCardId.set(legacyToolUsage.toolUsageCardId, {
        toolName: legacyToolUsage.toolName,
        args: legacyToolUsage.args,
      })
    }
    const title = sanitizeDeepSearchRows([rawTitle])[0] || ""
    const bullets = sanitizeDeepSearchRows(Array.isArray(detail.bullets) ? detail.bullets : [])
    if (!title && bullets.length === 0) {
      continue
    }
    thoughtItems.push({
      title: title || "思考过程",
      bullets,
    })
  }

  let toolIndex = 0
  let thoughtIndex = 0
  let entryIndex = 0
  const toLegacyResolvedEntry = (entry: StructuredReasoningEntry): StructuredReasoningEntry => {
    const legacyToolUsage = legacyToolUsageByCardId.get((entry.toolUsageCardId || "").trim())
    if (!legacyToolUsage) {
      return {
        ...entry,
        status: entry.status || "completed",
      }
    }
    const fallbackQuery = readToolUsageQueries(legacyToolUsage.args)[0]
    const fallbackCount = readRequestedResultsCount(legacyToolUsage.args)
    return {
      ...entry,
      toolName: (entry.toolName || "").trim() || legacyToolUsage.toolName || "tool",
      text: (entry.text || "").trim() || fallbackQuery || "",
      resultsCount: typeof entry.resultsCount === "number" ? entry.resultsCount : fallbackCount,
      status: entry.status || "completed",
    }
  }

  for (const thought of thoughtItems) {
    timeline.push({
      kind: "thought",
      key: `deepsearch_legacy_thought_${thoughtIndex++}`,
      title: thought.title,
      bullets: thought.bullets,
    })

    // Legacy payload lacks step-level linkage. Interleave one tool after each thought
    // to preserve chronological readability instead of falling back to agent grouping.
    if (entryIndex < entries.length) {
      timeline.push({
        kind: "tool",
        key: `deepsearch_legacy_tool_${toolIndex++}`,
        entry: toLegacyResolvedEntry(entries[entryIndex]!),
      })
      entryIndex += 1
    }
  }

  while (entryIndex < entries.length) {
    timeline.push({
      kind: "tool",
      key: `deepsearch_legacy_tool_${toolIndex++}`,
      entry: toLegacyResolvedEntry(entries[entryIndex]!),
    })
    entryIndex += 1
  }

  return timeline
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
    label: "NBSearch",
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
      label: key === "grok_primary" ? "NBSearch" : key.replace(/_/g, " "),
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
    label: key === "grok_primary" ? "NBSearch" : key.replace(/_/g, " "),
    paletteIndex: 0,
    isPrimary: key === "grok_primary",
  }
}
