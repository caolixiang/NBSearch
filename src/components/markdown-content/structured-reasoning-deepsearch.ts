import type {
  ChatDeepSearchDetail,
  ChatDeepSearchResearchStep,
} from "@/domain/chat/types"
import type { StructuredReasoningEntry } from "./types"
import type {
  DeepSearchGroupedItem,
  DeepSearchGroupedSection,
  DeepSearchTimelineItem,
} from "./structured-reasoning-models"
import { isLikelyUrl } from "./think-parser"
import {
  humanizeToolName,
  readRequestedResultsCount,
  readToolUsageQueries,
} from "./structured-reasoning-tools"

const DEEPSEARCH_XML_ROW_PATTERN = /<\/?xai:[^>]*>/i
const LEGACY_TOOL_USAGE_CARD_ID_XML_PATTERN = /<xai:tool_usage_card_id>([^<]+)<\/xai:tool_usage_card_id>/i
const LEGACY_TOOL_NAME_XML_PATTERN = /<xai:tool_name>([^<]+)<\/xai:tool_name>/i
const LEGACY_TOOL_ARGS_XML_PATTERN = /<xai:tool_args><!\[CDATA\[(.*?)\]\]><\/xai:tool_args>/is

function sanitizeDeepSearchRows(rows: string[]): string[] {
  return rows
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
    const resultsCountFromArgs = readRequestedResultsCount(usage.args || {})
    const resultsCountFromRows = Array.isArray(usage.webSearchResults) ? usage.webSearchResults.length : undefined
    return {
      key: `${fallbackKeyPrefix}:${toolUsageCardId}`,
      toolUsageCardId,
      rolloutId: "Grok",
      text,
      visited: isLikelyUrl(text),
      toolName: normalizedToolName,
      resultsCount:
        typeof resultsCountFromRows === "number" && resultsCountFromRows > 0
          ? resultsCountFromRows
          : resultsCountFromArgs,
      status: "completed",
      webSearchResults:
        Array.isArray(usage.webSearchResults) && usage.webSearchResults.length > 0
          ? usage.webSearchResults
          : undefined,
    }
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
      flush()
      current = {
        title: titleCandidate || rows[0] || "深度挖掘细节",
        items: [],
      }
      if (!titleCandidate && rows.length > 1) {
        pushSummaryRows(rows.slice(1))
      }
      continue
    }

    if (hasSummaryTag) {
      ensureCurrent(titleCandidate || "深度挖掘细节")
      pushSummaryRows(titleCandidate && rows[0] === titleCandidate ? rows.slice(1) : rows)
      continue
    }

    if (hasToolUsageTag || stepToolUsageIds.length > 0 || stepToolUsages.length > 0) {
      ensureCurrent(titleCandidate || "深度挖掘细节")
      const usageById = new Map<string, NonNullable<ChatDeepSearchResearchStep["toolUsages"]>[number]>()
      for (const usage of stepToolUsages) {
        const key = usage.toolUsageCardId.trim()
        if (!key || usageById.has(key)) {
          continue
        }
        usageById.set(key, usage)
      }

      const renderedToolUsageIds = new Set<string>()
      const appendToolEntries = (toolUsageCardId: string, nextEntries: StructuredReasoningEntry[]) => {
        if (nextEntries.length === 0) {
          return
        }
        current!.items.push({
          kind: "tool",
          key: `tool_${itemIndex++}`,
          entries: nextEntries.map((entry) => ({
            ...entry,
            status: entry.status || "completed",
          })),
        })
        renderedToolUsageIds.add(toolUsageCardId)
      }

      for (const toolUsageCardId of stepToolUsageIds) {
        const mappedEntries = entriesByToolUsageCardId.get(toolUsageCardId) || []
        if (mappedEntries.length > 0) {
          appendToolEntries(toolUsageCardId, mappedEntries)
          continue
        }

        const usage = usageById.get(toolUsageCardId)
        if (usage) {
          appendToolEntries(toolUsageCardId, [createSyntheticEntry(usage, `step_${sectionIndex}_${itemIndex}`)])
        }
      }

      for (const usage of stepToolUsages) {
        const key = usage.toolUsageCardId.trim()
        if (!key || renderedToolUsageIds.has(key)) {
          continue
        }
        appendToolEntries(key, [createSyntheticEntry(usage, `step_${sectionIndex}_${itemIndex}`)])
      }
      continue
    }

    if (rows.length > 0) {
      ensureCurrent(titleCandidate || "深度挖掘细节")
      pushSummaryRows(titleCandidate ? [titleCandidate, ...rows] : rows)
    }
  }

  flush()
  return sections
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
