import type {
  ChatCitationCard,
  ChatDeepSearchDetail,
  ChatDeepSearchResearch,
  ChatDeepSearchResearchStep,
  ChatDeepSearchResearchStepToolUsage,
  ChatInlineCitation,
} from "../../domain/chat/types"
import { isRecord, readOptionalString, readStringArray } from "./chunk-parsers-common"
import { parseCitationCards, parseInlineCitations } from "./chunk-parsers-research-citations"
import { parseResearchSteps } from "./chunk-parsers-research-steps"

function normalizeResearchIsoTime(value: unknown): string | undefined {
  const raw = readOptionalString(value)
  if (!raw) {
    return undefined
  }
  const millis = Date.parse(raw)
  if (!Number.isFinite(millis)) {
    return undefined
  }
  return new Date(millis).toISOString()
}

export function parseResearchDetailsFromSteps(steps: ChatDeepSearchResearchStep[]): ChatDeepSearchDetail[] {
  if (steps.length === 0) {
    return []
  }

  const details: ChatDeepSearchDetail[] = []
  let current: ChatDeepSearchDetail | null = null

  const pushCurrent = () => {
    if (!current) {
      return
    }
    const normalizedBullets = current.bullets
      .map((row) => row.trim())
      .filter(Boolean)
    if (!current.title.trim() && normalizedBullets.length === 0) {
      current = null
      return
    }
    details.push({
      title: current.title.trim() || "深度挖掘细节",
      bullets: Array.from(new Set(normalizedBullets)),
    })
    current = null
  }

  for (const step of steps) {
    const tags = step.tags.map((tag) => tag.toLowerCase())
    const hasHeaderTag = tags.includes("header")
    const hasSummaryTag = tags.includes("summary")
    const titleCandidate = step.title
    const textRows = step.text

    if (hasHeaderTag) {
      pushCurrent()
      const [firstText, ...restText] = textRows
      current = {
        title: titleCandidate || firstText || "深度挖掘细节",
        bullets: restText,
      }
      continue
    }

    if (hasSummaryTag) {
      if (!current) {
        current = {
          title: titleCandidate || "深度挖掘细节",
          bullets: [],
        }
      }
      current.bullets.push(...textRows)
      continue
    }

    if (titleCandidate || textRows.length > 0) {
      pushCurrent()
      const [firstText, ...restText] = textRows
      details.push({
        title: titleCandidate || firstText || "深度挖掘细节",
        bullets: titleCandidate ? textRows : restText,
      })
    }
  }

  pushCurrent()

  const deduped: ChatDeepSearchDetail[] = []
  const seen = new Set<string>()
  for (const detail of details) {
    const title = detail.title.trim()
    const bullets = detail.bullets
      .map((row) => row.trim())
      .filter(Boolean)
      .slice(0, 6)
    const key = `${title}\u0000${bullets.join("\u0001")}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push({
      title: title || "深度挖掘细节",
      bullets,
    })
  }
  return deduped
}

export function parseResearchObject(value: unknown): Partial<ChatDeepSearchResearch> {
  if (!isRecord(value)) {
    return {}
  }

  const metadata = isRecord(value.metadata) ? value.metadata : null
  const requestMetadata = isRecord(value.request_metadata)
    ? value.request_metadata
    : isRecord(value.requestMetadata)
      ? value.requestMetadata
      : metadata && isRecord(metadata.requestMetadata)
        ? metadata.requestMetadata
        : metadata && isRecord(metadata.request_metadata)
          ? metadata.request_metadata
      : undefined
  const uiLayoutRaw = isRecord(value.ui_layout) ? value.ui_layout : isRecord(value.uiLayout) ? value.uiLayout : null
  const uiLayout = uiLayoutRaw
    ? {
        reasoningUiLayout: readOptionalString(uiLayoutRaw.reasoningUiLayout),
        willThinkLong:
          typeof uiLayoutRaw.willThinkLong === "boolean" ? uiLayoutRaw.willThinkLong : undefined,
        effort: readOptionalString(uiLayoutRaw.effort),
        rolloutIds: readStringArray(uiLayoutRaw.rolloutIds),
      }
    : undefined
  const steps = parseResearchSteps(value.steps)
  const details = parseResearchDetailsFromSteps(steps)
  const citationCards = parseCitationCards(value.citation_cards || value.citationCards)
  const inlineCitations = parseInlineCitations(value.inline_citations || value.inlineCitations)

  return {
    requestMetadata: requestMetadata ? { ...requestMetadata } : undefined,
    uiLayout,
    deepsearchPreset:
      readOptionalString(value.deepsearch_preset) ||
      readOptionalString(value.deepsearchPreset) ||
      readOptionalString(metadata?.deepsearch_preset) ||
      readOptionalString(metadata?.deepsearchPreset),
    thinkingStartTime:
      normalizeResearchIsoTime(value.thinking_start_time) ||
      normalizeResearchIsoTime(value.thinkingStartTime) ||
      normalizeResearchIsoTime(metadata?.thinking_start_time) ||
      normalizeResearchIsoTime(metadata?.thinkingStartTime),
    thinkingEndTime:
      normalizeResearchIsoTime(value.thinking_end_time) ||
      normalizeResearchIsoTime(value.thinkingEndTime) ||
      normalizeResearchIsoTime(metadata?.thinking_end_time) ||
      normalizeResearchIsoTime(metadata?.thinkingEndTime),
    details: details.length > 0 ? details : undefined,
    steps: steps.length > 0 ? steps : undefined,
    citationCards: citationCards.length > 0 ? citationCards : undefined,
    inlineCitations: inlineCitations.length > 0 ? inlineCitations : undefined,
  }
}

export function hasResearchFragment(value: Partial<ChatDeepSearchResearch>): boolean {
  return Boolean(
    value.requestMetadata ||
      value.uiLayout ||
      (value.deepsearchPreset || "").trim() ||
      (value.thinkingStartTime || "").trim() ||
      (value.thinkingEndTime || "").trim() ||
      (Array.isArray(value.steps) && value.steps.length > 0) ||
      (Array.isArray(value.details) && value.details.length > 0) ||
      (Array.isArray(value.citationCards) && value.citationCards.length > 0) ||
      (Array.isArray(value.inlineCitations) && value.inlineCitations.length > 0)
  )
}

export function mergeResearchFragments(
  previous: Partial<ChatDeepSearchResearch>,
  next: Partial<ChatDeepSearchResearch>
): Partial<ChatDeepSearchResearch> {
  const merged: Partial<ChatDeepSearchResearch> = {
    requestMetadata:
      next.requestMetadata && Object.keys(next.requestMetadata).length > 0
        ? next.requestMetadata
        : previous.requestMetadata,
    uiLayout: next.uiLayout || previous.uiLayout,
    deepsearchPreset: next.deepsearchPreset || previous.deepsearchPreset,
    thinkingStartTime: next.thinkingStartTime || previous.thinkingStartTime,
    thinkingEndTime: next.thinkingEndTime || previous.thinkingEndTime,
  }

  const citationByKey = new Map<string, ChatCitationCard>()
  for (const row of [...(previous.citationCards || []), ...(next.citationCards || [])]) {
    const key = `${row.cardId}\u0000${row.url || ""}`
    if (!citationByKey.has(key)) {
      citationByKey.set(key, row)
    }
  }
  if (citationByKey.size > 0) {
    merged.citationCards = Array.from(citationByKey.values())
  }

  const inlineByKey = new Map<string, ChatInlineCitation>()
  for (const row of [...(previous.inlineCitations || []), ...(next.inlineCitations || [])]) {
    const key = `${row.cardId}\u0000${row.citationId || ""}\u0000${row.url || ""}`
    if (!inlineByKey.has(key)) {
      inlineByKey.set(key, row)
    }
  }
  if (inlineByKey.size > 0) {
    merged.inlineCitations = Array.from(inlineByKey.values())
  }

  const detailByKey = new Map<string, ChatDeepSearchDetail>()
  for (const row of [...(previous.details || []), ...(next.details || [])]) {
    const title = row.title.trim()
    const bullets = row.bullets.map((item) => item.trim()).filter(Boolean)
    const key = `${title}\u0000${bullets.join("\u0001")}`
    if (!detailByKey.has(key)) {
      detailByKey.set(key, {
        title: title || "深度挖掘细节",
        bullets,
      })
    }
  }
  if (detailByKey.size > 0) {
    merged.details = Array.from(detailByKey.values())
  }

  const stepByKey = new Map<string, ChatDeepSearchResearchStep>()
  for (const step of [...(previous.steps || []), ...(next.steps || [])]) {
    const tags = step.tags.map((row) => row.trim()).filter(Boolean)
    const text = step.text.map((row) => row.trim()).filter(Boolean)
    const toolUsageCardIds = (step.toolUsageCardIds || []).map((row) => row.trim()).filter(Boolean)
    const toolUsages: ChatDeepSearchResearchStepToolUsage[] = []
    for (const usage of step.toolUsages || []) {
      const toolUsageCardId = (usage.toolUsageCardId || "").trim()
      if (!toolUsageCardId) {
        continue
      }
      toolUsages.push({
        toolUsageCardId,
        toolName: (usage.toolName || "").trim() || "tool",
        args: isRecord(usage.args) ? usage.args : {},
        webSearchResults: Array.isArray(usage.webSearchResults)
          ? usage.webSearchResults.map((row) => {
              const authorName = (row.authorName || "").trim()
              const authorHandle = (row.authorHandle || "").trim()
              const publishedAt = (row.publishedAt || "").trim()
              const postId = (row.postId || "").trim()
              return {
                ...(row.kind === "x_post" ? { kind: "x_post" as const } : {}),
                title: (row.title || "").trim() || undefined,
                url: (row.url || "").trim() || undefined,
                preview: (row.preview || "").trim() || undefined,
                favicon: (row.favicon || "").trim() || undefined,
                ...(authorName ? { authorName } : {}),
                ...(authorHandle ? { authorHandle } : {}),
                ...(publishedAt ? { publishedAt } : {}),
                ...(postId ? { postId } : {}),
              }
            })
          : undefined,
      })
    }
    const title = (step.title || "").trim()
    const key = `${tags.join("\u0001")}\u0000${title}\u0000${text.join("\u0001")}\u0000${toolUsageCardIds.join("\u0001")}\u0000${toolUsages
      .map(
        (usage) =>
          `${usage.toolUsageCardId}\u0001${usage.toolName}\u0001${JSON.stringify(usage.args)}\u0001${(usage.webSearchResults || [])
            .map((row) => `${row.url || ""}\u0002${row.title || ""}`)
            .join("\u0003")}`
      )
      .join("\u0004")}`
    if (stepByKey.has(key)) {
      continue
    }
    stepByKey.set(key, {
      tags,
      title: title || undefined,
      text,
      toolUsageCardIds: toolUsageCardIds.length > 0 ? toolUsageCardIds : undefined,
      toolUsages: toolUsages.length > 0 ? toolUsages : undefined,
    })
  }
  if (stepByKey.size > 0) {
    merged.steps = Array.from(stepByKey.values())
  }

  return merged
}
