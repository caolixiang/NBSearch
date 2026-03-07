import type { ChatReasoningEventDetail, ChatReasoningLayout } from "../../domain/chat/types"
import {
  collectRawChunkCandidates,
  extractResponseIdFromRecord,
  isRecord,
  parseFunctionArguments,
  readStringArray,
  readToolUsageCard,
  readWebSearchResults,
  readWebSearchResultsCount,
} from "./chunk-parsers-common"
import {
  extractCardAttachmentsFromRawChunk,
} from "./chunk-parsers-card-attachments"
import { extractGatewayResponseIdFromRawChunk } from "./chunk-parsers-response"

function readReasoningLayout(rawChunk: unknown): {
  layout: ChatReasoningLayout
  isThinking?: boolean
  responseId?: string
} | null {
  const responseId = extractGatewayResponseIdFromRawChunk(rawChunk)
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    const uiLayout = isRecord(candidate.uiLayout) ? candidate.uiLayout : null
    if (!uiLayout) {
      continue
    }

    return {
      layout: {
        reasoningUiLayout: typeof uiLayout.reasoningUiLayout === "string" ? uiLayout.reasoningUiLayout : undefined,
        willThinkLong: typeof uiLayout.willThinkLong === "boolean" ? uiLayout.willThinkLong : undefined,
        effort: typeof uiLayout.effort === "string" ? uiLayout.effort : undefined,
        rolloutIds: readStringArray(uiLayout.rolloutIds),
      },
      isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
      responseId: responseId || undefined,
    }
  }

  return null
}

function readToolUsageEvent(rawChunk: unknown): ChatReasoningEventDetail | null {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (
      candidate.type === "response.output_item.added" &&
      isRecord(candidate.item) &&
      candidate.item.type === "function_call"
    ) {
      const args = parseFunctionArguments(candidate.item.arguments) || {}
      const toolUsageCardId =
        typeof candidate.item.call_id === "string" && candidate.item.call_id.trim()
          ? candidate.item.call_id.trim()
          : typeof candidate.item.id === "string" && candidate.item.id.trim()
            ? candidate.item.id.trim()
            : ""
      if (!toolUsageCardId) {
        continue
      }

      const responseId = extractResponseIdFromRecord(candidate)
      return {
        kind: "tool_usage",
        usage: {
          toolUsageCardId,
          toolName: typeof candidate.item.name === "string" ? candidate.item.name : "tool",
          args,
          rolloutId: typeof candidate.item.rollout_id === "string" ? candidate.item.rollout_id : undefined,
          messageTag: typeof candidate.messageTag === "string" ? candidate.messageTag : undefined,
          isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
          responseId: responseId || undefined,
        },
      }
    }

    const messageTag = typeof candidate.messageTag === "string" ? candidate.messageTag : ""
    const hasToolUsagePayload = isRecord(candidate.toolUsageCard)
    const isToolUsageType = candidate.type === "response.tool_usage_card"
    const isToolUsageMessageTag = messageTag === "tool_usage_card"
    if (!hasToolUsagePayload || (!isToolUsageType && !isToolUsageMessageTag)) {
      continue
    }

    const toolUsage = readToolUsageCard(candidate.toolUsageCard)
    if (!toolUsage) {
      continue
    }

    const responseId = extractResponseIdFromRecord(candidate)
    return {
      kind: "tool_usage",
      usage: {
        toolUsageCardId: toolUsage.toolUsageCardId,
        toolName: toolUsage.toolName,
        args: toolUsage.args,
        rolloutId:
          typeof candidate.rolloutId === "string"
            ? candidate.rolloutId
            : typeof candidate.rollout_id === "string"
              ? candidate.rollout_id
              : undefined,
        messageTag: messageTag || undefined,
        isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
        responseId: responseId || undefined,
      },
    }
  }

  return null
}

function readToolResultEvent(rawChunk: unknown): ChatReasoningEventDetail | null {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (
      candidate.type === "response.output_item.done" &&
      isRecord(candidate.item) &&
      candidate.item.type === "function_call"
    ) {
      const toolUsageCardId =
        typeof candidate.item.call_id === "string" && candidate.item.call_id.trim()
          ? candidate.item.call_id.trim()
          : typeof candidate.item.id === "string" && candidate.item.id.trim()
            ? candidate.item.id.trim()
            : undefined
      const responseId = extractResponseIdFromRecord(candidate)
      return {
        kind: "tool_result",
        result: {
          toolUsageCardId,
          rolloutId: typeof candidate.item.rollout_id === "string" ? candidate.item.rollout_id : undefined,
          messageTag: typeof candidate.messageTag === "string" ? candidate.messageTag : undefined,
          isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
          responseId: responseId || undefined,
        },
      }
    }

    if (typeof candidate.messageTag !== "string" || candidate.messageTag !== "raw_function_result") {
      continue
    }

    const searchResultsPayload = candidate.webSearchResults ?? candidate.xSearchResults
    const webSearchResultsCount = readWebSearchResultsCount(searchResultsPayload)
    if (typeof webSearchResultsCount !== "number") {
      continue
    }
    const webSearchResults = readWebSearchResults(searchResultsPayload)
    const responseId = extractResponseIdFromRecord(candidate)
    return {
      kind: "tool_result",
      result: {
        toolUsageCardId: typeof candidate.toolUsageCardId === "string" ? candidate.toolUsageCardId : undefined,
        rolloutId:
          typeof candidate.rolloutId === "string"
            ? candidate.rolloutId
            : typeof candidate.rollout_id === "string"
              ? candidate.rollout_id
              : undefined,
        messageTag: candidate.messageTag,
        webSearchResultsCount,
        webSearchResults,
        isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
        responseId: responseId || undefined,
      },
    }
  }

  return null
}

export function extractReasoningEventsFromRawChunk(rawChunk: unknown): ChatReasoningEventDetail[] {
  const events: ChatReasoningEventDetail[] = []

  const layout = readReasoningLayout(rawChunk)
  if (layout) {
    events.push({
      kind: "ui_layout",
      layout: layout.layout,
      isThinking: layout.isThinking,
      responseId: layout.responseId,
    })
  }

  const toolUsage = readToolUsageEvent(rawChunk)
  if (toolUsage) {
    events.push(toolUsage)
  }

  const toolResult = readToolResultEvent(rawChunk)
  if (toolResult) {
    events.push(toolResult)
  }

  for (const card of extractCardAttachmentsFromRawChunk(rawChunk)) {
    events.push({
      kind: "card_attachment",
      card,
    })
  }

  return events
}
