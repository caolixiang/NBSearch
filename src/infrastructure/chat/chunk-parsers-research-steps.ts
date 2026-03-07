import type {
  ChatDeepSearchResearchStep,
  ChatDeepSearchResearchStepToolUsage,
  WebSearchResultItem,
} from "../../domain/chat/types"
import {
  isRecord,
  parseFunctionArguments,
  readOptionalString,
  readStringArray,
  readStringOrStringArray,
  readWebSearchResults,
} from "./chunk-parsers-common"

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

export function parseResearchSteps(value: unknown): ChatDeepSearchResearchStep[] {
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

export function parseResearchStepFromMessageTag(
  value: Record<string, unknown>
): ChatDeepSearchResearchStep | null {
  const messageTag = (readOptionalString(value.messageTag) || "").toLowerCase()
  if (messageTag !== "header" && messageTag !== "summary") {
    return null
  }

  const normalized = (readOptionalString(value.token) || readOptionalString(value.message) || "")
    .replace(/<xai:tool_usage_card[\s\S]*?<\/xai:tool_usage_card>/gi, " ")
    .replace(/<grok:render[\s\S]*?<\/grok:render>/gi, " ")
    .trim()
  if (!normalized) {
    return null
  }

  const rows = normalized
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean)
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
