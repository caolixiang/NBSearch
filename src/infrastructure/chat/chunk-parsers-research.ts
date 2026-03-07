import type {
  ChatCardAttachmentPayload,
  ChatCitationCard,
  ChatDeepSearchDetail,
  ChatDeepSearchResearch,
  ChatDeepSearchResearchStep,
  ChatDeepSearchResearchStepToolUsage,
  ChatInlineCitation,
  WebSearchResultItem,
} from "../../domain/chat/types"
import {
  collectRawChunkCandidates,
  isRecord,
  parseFunctionArguments,
  readOptionalString,
  readStringArray,
  readStringOrStringArray,
  readWebSearchResults,
} from "./chunk-parsers-common"
import { extractCardAttachmentsFromRawChunk } from "./chunk-parsers-card-attachments"

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

function extractAttrValue(rawAttrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}="([^"]+)"`, "i")
  const matched = rawAttrs.match(pattern)?.[1]
  if (!matched) {
    return undefined
  }
  const trimmed = matched.trim()
  return trimmed || undefined
}

function extractArgumentValue(body: string, name: string): string | undefined {
  const pattern = new RegExp(`<argument\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/argument>`, "i")
  const matched = body.match(pattern)?.[1]
  if (!matched) {
    return undefined
  }
  const trimmed = matched.trim()
  return trimmed || undefined
}

function parseCitationCards(value: unknown): ChatCitationCard[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ChatCitationCard[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const cardId =
      readOptionalString(item.card_id) ||
      readOptionalString(item.cardId) ||
      readOptionalString(item.id) ||
      ""
    if (!cardId) {
      continue
    }
    rows.push({
      cardId,
      cardType: readOptionalString(item.card_type) || readOptionalString(item.cardType),
      url: readOptionalString(item.url),
    })
  }
  return rows
}

function parseInlineCitations(value: unknown): ChatInlineCitation[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: ChatInlineCitation[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const cardId =
      readOptionalString(item.card_id) ||
      readOptionalString(item.cardId) ||
      readOptionalString(item.id) ||
      ""
    if (!cardId) {
      continue
    }
    rows.push({
      cardId,
      citationId: readOptionalString(item.citation_id) || readOptionalString(item.citationId),
      url: readOptionalString(item.url),
    })
  }
  return rows
}

const TOOL_USAGE_CARD_ID_XML_PATTERN =
  /<xai:tool_usage_card_id>\s*([^<\s][^<]*?)\s*<\/xai:tool_usage_card_id>/gi
const TOOL_USAGE_CARD_BLOCK_XML_PATTERN =
  /<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>/gi
const TOOL_USAGE_CARD_NAME_XML_PATTERN = /<xai:tool_name>\s*([^<\s][^<]*?)\s*<\/xai:tool_name>/i
const TOOL_USAGE_CARD_ARGS_XML_PATTERN =
  /<xai:tool_args>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/xai:tool_args>/i

type StepToolUsageCard = {
  toolUsageCardId: string
  toolName: string
  args: Record<string, unknown>
}

function extractToolUsageCardIdsFromUnknown(value: unknown): string[] {
  const results: string[] = []
  const seen = new Set<string>()
  const append = (input: string | undefined) => {
    const normalized = (input || "").trim()
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    results.push(normalized)
  }

  const parseText = (source: string) => {
    TOOL_USAGE_CARD_ID_XML_PATTERN.lastIndex = 0
    let matched: RegExpExecArray | null = TOOL_USAGE_CARD_ID_XML_PATTERN.exec(source)
    while (matched) {
      append(matched[1])
      matched = TOOL_USAGE_CARD_ID_XML_PATTERN.exec(source)
    }
  }

  if (typeof value === "string") {
    parseText(value)
    return results
  }
  if (!Array.isArray(value)) {
    return results
  }

  for (const row of value) {
    if (typeof row === "string") {
      parseText(row)
      continue
    }
    if (!isRecord(row)) {
      continue
    }
    append(readOptionalString(row.toolUsageCardId) || readOptionalString(row.tool_usage_card_id))
    if (typeof row.xml === "string") {
      parseText(row.xml)
    }
  }
  return results
}

function parseToolUsageCardsFromStep(value: unknown): StepToolUsageCard[] {
  if (!Array.isArray(value)) {
    return []
  }

  const byId = new Map<string, StepToolUsageCard>()
  for (const row of value) {
    if (!isRecord(row)) {
      continue
    }
    const toolUsageCardId =
      readOptionalString(row.toolUsageCardId) || readOptionalString(row.tool_usage_card_id) || ""
    if (!toolUsageCardId) {
      continue
    }

    let toolName = readOptionalString(row.toolName) || readOptionalString(row.tool_name) || ""
    let args: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(row)) {
      if (key === "toolUsageCardId" || key === "tool_usage_card_id") {
        continue
      }
      if (!isRecord(nested)) {
        continue
      }
      const nestedArgs = isRecord(nested.args) ? nested.args : {}
      if (!toolName) {
        toolName = key
      }
      if (Object.keys(args).length === 0 && Object.keys(nestedArgs).length > 0) {
        args = nestedArgs
      }
    }

    const existing = byId.get(toolUsageCardId)
    if (existing) {
      const mergedToolName = existing.toolName || toolName || "tool"
      const mergedArgs =
        Object.keys(existing.args).length > 0
          ? existing.args
          : Object.keys(args).length > 0
            ? args
            : {}
      byId.set(toolUsageCardId, {
        toolUsageCardId,
        toolName: mergedToolName,
        args: mergedArgs,
      })
      continue
    }

    byId.set(toolUsageCardId, {
      toolUsageCardId,
      toolName: toolName || "tool",
      args,
    })
  }

  return Array.from(byId.values())
}

function parseToolUsageCardsFromXmlText(textRows: string[]): StepToolUsageCard[] {
  const byId = new Map<string, StepToolUsageCard>()

  for (const row of textRows) {
    TOOL_USAGE_CARD_BLOCK_XML_PATTERN.lastIndex = 0
    let blockMatched: RegExpExecArray | null = TOOL_USAGE_CARD_BLOCK_XML_PATTERN.exec(row)
    while (blockMatched) {
      const block = blockMatched[0] || ""
      TOOL_USAGE_CARD_ID_XML_PATTERN.lastIndex = 0
      const idMatched = TOOL_USAGE_CARD_ID_XML_PATTERN.exec(block)
      const toolUsageCardId = (idMatched?.[1] || "").trim()
      if (!toolUsageCardId) {
        blockMatched = TOOL_USAGE_CARD_BLOCK_XML_PATTERN.exec(row)
        continue
      }

      const nameMatched = TOOL_USAGE_CARD_NAME_XML_PATTERN.exec(block)
      const argsMatched = TOOL_USAGE_CARD_ARGS_XML_PATTERN.exec(block)
      const args = parseFunctionArguments((argsMatched?.[1] || "").trim()) || {}
      const toolName = (nameMatched?.[1] || "").trim() || "tool"
      const existing = byId.get(toolUsageCardId)
      if (existing) {
        byId.set(toolUsageCardId, {
          toolUsageCardId,
          toolName: existing.toolName || toolName,
          args: Object.keys(existing.args).length > 0 ? existing.args : args,
        })
      } else {
        byId.set(toolUsageCardId, {
          toolUsageCardId,
          toolName,
          args,
        })
      }
      blockMatched = TOOL_USAGE_CARD_BLOCK_XML_PATTERN.exec(row)
    }
  }

  return Array.from(byId.values())
}

function parseToolUsageResultsFromStep(value: unknown): Map<string, WebSearchResultItem[]> {
  const result = new Map<string, WebSearchResultItem[]>()
  if (!Array.isArray(value)) {
    return result
  }

  for (const row of value) {
    if (!isRecord(row)) {
      continue
    }
    const toolUsageCardId =
      readOptionalString(row.toolUsageCardId) || readOptionalString(row.tool_usage_card_id) || ""
    if (!toolUsageCardId) {
      continue
    }
    const webSearchResults = readWebSearchResults(row.webSearchResults ?? row.xSearchResults)
    if (!Array.isArray(webSearchResults) || webSearchResults.length === 0) {
      continue
    }
    result.set(toolUsageCardId, webSearchResults)
  }

  return result
}

function parseResearchSteps(value: unknown): ChatDeepSearchResearchStep[] {
  if (!Array.isArray(value)) {
    return []
  }

  const rows: ChatDeepSearchResearchStep[] = []
  const seen = new Set<string>()

  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }

    const tags = readStringArray(item.tags)
      .map((tag) => tag.trim())
      .filter(Boolean)
    const title =
      readOptionalString(item.header) ||
      readOptionalString(item.title) ||
      readOptionalString(item.name) ||
      readOptionalString(item.label)
    const text = Array.from(
      new Set([
        ...readStringOrStringArray(item.summary),
        ...readStringOrStringArray(item.text),
        ...readStringOrStringArray(item.bullets),
        ...readStringOrStringArray(item.points),
      ])
    )
      .map((row) => row.trim())
      .filter(Boolean)
    const stepToolUsageCards = [
      ...parseToolUsageCardsFromStep(item.toolUsageCards),
      ...parseToolUsageCardsFromStep(item.tool_usage_cards),
      ...parseToolUsageCardsFromXmlText(text),
    ]
    const stepToolUsageResults = new Map<string, WebSearchResultItem[]>([
      ...parseToolUsageResultsFromStep(item.toolUsageResults).entries(),
      ...parseToolUsageResultsFromStep(item.tool_usage_results).entries(),
    ])
    const toolUsageCardIds = Array.from(
      new Set([
        ...extractToolUsageCardIdsFromUnknown(item.toolUsageCards),
        ...extractToolUsageCardIdsFromUnknown(item.tool_usage_cards),
        ...extractToolUsageCardIdsFromUnknown(item.toolUsageResults),
        ...extractToolUsageCardIdsFromUnknown(item.tool_usage_results),
        ...stepToolUsageCards.map((row) => row.toolUsageCardId),
        ...Array.from(stepToolUsageResults.keys()),
        ...extractToolUsageCardIdsFromUnknown(text),
      ])
    )
    const toolUsageById = new Map<string, ChatDeepSearchResearchStepToolUsage>()
    for (const card of stepToolUsageCards) {
      toolUsageById.set(card.toolUsageCardId, {
        toolUsageCardId: card.toolUsageCardId,
        toolName: card.toolName || "tool",
        args: card.args,
        webSearchResults: stepToolUsageResults.get(card.toolUsageCardId),
      })
    }
    for (const [toolUsageCardId, webSearchResults] of stepToolUsageResults.entries()) {
      if (!toolUsageById.has(toolUsageCardId)) {
        toolUsageById.set(toolUsageCardId, {
          toolUsageCardId,
          toolName: "web_search",
          args: {},
          webSearchResults,
        })
      }
    }
    for (const toolUsageCardId of toolUsageCardIds) {
      if (!toolUsageById.has(toolUsageCardId)) {
        toolUsageById.set(toolUsageCardId, {
          toolUsageCardId,
          toolName: "tool",
          args: {},
        })
      }
    }
    const toolUsagesOrdered = toolUsageCardIds
      .map((toolUsageCardId) => toolUsageById.get(toolUsageCardId))
      .filter((row): row is ChatDeepSearchResearchStepToolUsage => Boolean(row))

    const normalized: ChatDeepSearchResearchStep = {
      tags,
      title: title || undefined,
      text,
      toolUsageCardIds: toolUsageCardIds.length > 0 ? toolUsageCardIds : undefined,
      toolUsages: toolUsagesOrdered.length > 0 ? toolUsagesOrdered : undefined,
    }

    const key = [
      normalized.tags.join("\u0001"),
      normalized.title || "",
      normalized.text.join("\u0001"),
      (normalized.toolUsageCardIds || []).join("\u0001"),
      (normalized.toolUsages || [])
        .map(
          (usage) =>
            `${usage.toolUsageCardId}\u0000${usage.toolName}\u0000${JSON.stringify(usage.args || {})}\u0000${(usage.webSearchResults || [])
              .map((row) => `${row.url || ""}\u0001${row.title || ""}`)
              .join("\u0002")}`
        )
        .join("\u0003"),
    ].join("\u0002")
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    rows.push(normalized)
  }

  return rows
}

function parseResearchDetailsFromSteps(steps: ChatDeepSearchResearchStep[]): ChatDeepSearchDetail[] {
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

function parseResearchObject(value: unknown): Partial<ChatDeepSearchResearch> {
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

function hasResearchFragment(value: Partial<ChatDeepSearchResearch>): boolean {
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

function mergeResearchFragments(
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

function toCitationCardFromAttachment(card: ChatCardAttachmentPayload): ChatCitationCard | null {
  const cardType = (card.cardType || card.type || "").trim()
  if (!cardType.toLowerCase().includes("citation")) {
    return null
  }
  const cardId = (card.id || "").trim()
  if (!cardId) {
    return null
  }
  const resolvedUrl = readOptionalString(card.url) || readOptionalString(card.image?.link)
  return {
    cardId,
    cardType: cardType || undefined,
    url: resolvedUrl,
  }
}

export function extractInlineCitationsFromText(value: string): ChatInlineCitation[] {
  const source = value.trim()
  if (!source) {
    return []
  }

  const rows: ChatInlineCitation[] = []
  const seen = new Set<string>()
  const renderPattern =
    /<grok:render\b([^>]*?)>([\s\S]*?)<\/grok:render>|<grok:render\b([^>]*?)\/>/gi
  let matched: RegExpExecArray | null = renderPattern.exec(source)
  while (matched) {
    const attrs = matched[1] || matched[3] || ""
    const body = matched[2] || ""
    const cardType = (extractAttrValue(attrs, "card_type") || extractAttrValue(attrs, "cardType") || "").toLowerCase()
    if (!cardType.includes("citation")) {
      matched = renderPattern.exec(source)
      continue
    }
    const cardId = extractAttrValue(attrs, "card_id") || extractAttrValue(attrs, "cardId") || ""
    if (!cardId) {
      matched = renderPattern.exec(source)
      continue
    }
    const citationId =
      extractArgumentValue(body, "citation_id") ||
      extractArgumentValue(body, "citationId") ||
      extractAttrValue(attrs, "citation_id") ||
      extractAttrValue(attrs, "citationId")
    const url =
      extractArgumentValue(body, "url") || extractAttrValue(attrs, "url")
    const key = `${cardId}\u0000${citationId || ""}\u0000${url || ""}`
    if (!seen.has(key)) {
      seen.add(key)
      rows.push({
        cardId,
        citationId: citationId || undefined,
        url: url || undefined,
      })
    }
    matched = renderPattern.exec(source)
  }

  return rows
}

export function extractDeepSearchResearchFromRawChunk(rawChunk: unknown): Partial<ChatDeepSearchResearch> {
  const parseStepRowsFromMessageToken = (value: string): string[] => {
    const normalized = value
      .replace(/<xai:tool_usage_card[\s\S]*?<\/xai:tool_usage_card>/gi, " ")
      .replace(/<grok:render[\s\S]*?<\/grok:render>/gi, " ")
      .trim()
    if (!normalized) {
      return []
    }
    return normalized
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*•]\s+/, "").trim())
      .filter(Boolean)
  }

  const parseStepFromMessageTag = (value: Record<string, unknown>): ChatDeepSearchResearchStep | null => {
    const messageTag = (readOptionalString(value.messageTag) || "").toLowerCase()
    if (messageTag !== "header" && messageTag !== "summary") {
      return null
    }
    const rows = parseStepRowsFromMessageToken(
      readOptionalString(value.token) || readOptionalString(value.message) || ""
    )
    if (rows.length === 0) {
      return null
    }
    const toolUsageCardId =
      readOptionalString(value.toolUsageCardId) || readOptionalString(value.tool_usage_card_id)
    return {
      tags: [messageTag],
      title: messageTag === "header" ? rows[0] : undefined,
      text: messageTag === "header" ? [rows[0]] : rows,
      toolUsageCardIds: toolUsageCardId ? [toolUsageCardId] : undefined,
    }
  }

  let merged: Partial<ChatDeepSearchResearch> = {}

  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    const fromXGrok =
      isRecord(candidate.x_grok) && isRecord(candidate.x_grok.research)
        ? parseResearchObject(candidate.x_grok.research)
        : {}
    if (hasResearchFragment(fromXGrok)) {
      merged = mergeResearchFragments(merged, fromXGrok)
    }

    const fromResearch = parseResearchObject(candidate.research)
    if (hasResearchFragment(fromResearch)) {
      merged = mergeResearchFragments(merged, fromResearch)
    }

    const fromModelResponse =
      isRecord(candidate.modelResponse)
        ? parseResearchObject(candidate.modelResponse)
        : {}
    if (hasResearchFragment(fromModelResponse)) {
      merged = mergeResearchFragments(merged, fromModelResponse)
    }

    const fromCandidate = parseResearchObject(candidate)
    if (hasResearchFragment(fromCandidate)) {
      merged = mergeResearchFragments(merged, fromCandidate)
    }

    const stepFromMessageTag = parseStepFromMessageTag(candidate)
    if (stepFromMessageTag) {
      merged = mergeResearchFragments(merged, {
        steps: [stepFromMessageTag],
        details: parseResearchDetailsFromSteps([stepFromMessageTag]),
      })
    }
  }

  const citationCards = extractCardAttachmentsFromRawChunk(rawChunk)
    .map((card) => toCitationCardFromAttachment(card))
    .filter((row): row is ChatCitationCard => Boolean(row))
  if (citationCards.length > 0) {
    merged = mergeResearchFragments(merged, { citationCards })
  }

  return merged
}
