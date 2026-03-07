import type {
  ChatAnchors,
  ChatMessage,
  ChatReasoningEventDetail,
  ChatReasoningLayout,
} from "../../domain/chat/types"
import {
  type AssistantToolMetaPayload,
  normalizeResponseIdCandidate,
  parseFunctionArguments,
  parseRecords,
  readAssistantResponseIdFromGatewayResponse,
  readExplicitResponseId,
  readStringArray,
  readWebSearchResults,
  readWebSearchResultsCount,
  extractResponseIdFromRecord,
  collectRawChunkCandidates,
  isInternalGatewayJsonToken,
  isRecord,
} from "./chunk-parsers-common"
import {
  extractCardAttachmentsFromRawChunk,
  extractGeneratedImageModeratedFromRawChunk,
} from "./chunk-parsers-card-attachments"
import {
  extractDeepSearchResearchFromRawChunk,
  extractInlineCitationsFromText,
} from "./chunk-parsers-research"

export type { AssistantToolMetaPayload, WebSearchToolMeta } from "./chunk-parsers-common"
export {
  extractWebSearchToolMetaFromRawChunk,
  isRecord,
  parseJsonObjectStrings,
} from "./chunk-parsers-common"
export {
  extractCardAttachmentsFromRawChunk,
  extractGeneratedImageModeratedFromRawChunk,
} from "./chunk-parsers-card-attachments"
export {
  extractDeepSearchResearchFromRawChunk,
  extractInlineCitationsFromText,
} from "./chunk-parsers-research"

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

function readToolUsageCard(
  value: unknown
): { toolUsageCardId: string; toolName: string; args: Record<string, unknown> } | null {
  if (!isRecord(value)) {
    return null
  }

  const toolUsageCardId =
    typeof value.toolUsageCardId === "string" && value.toolUsageCardId.trim()
      ? value.toolUsageCardId.trim()
      : ""
  if (!toolUsageCardId) {
    return null
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "toolUsageCardId" || !isRecord(nested) || !isRecord(nested.args)) {
      continue
    }
    return {
      toolUsageCardId,
      toolName: key,
      args: nested.args,
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

// ---------------------------------------------------------------------------
// Tool meta / title
// ---------------------------------------------------------------------------

export function appendToolMeta(content: string, payload: AssistantToolMetaPayload): string {
  if (payload.webSearch.length === 0 && payload.cards.length === 0) {
    return content
  }
  const metaPayload = JSON.stringify(payload)
  return `${content}\n<tool-meta>${metaPayload}</tool-meta>`
}

function readNewTitle(value: unknown): string {
  if (!isRecord(value)) {
    return ""
  }
  const title = value.title
  if (!isRecord(title)) {
    return ""
  }
  const newTitle = title.newTitle
  if (typeof newTitle !== "string") {
    return ""
  }
  return newTitle.trim()
}

function normalizeConversationTitle(value: string): string {
  const normalized = value.replace(/<eos>\s*$/i, "").trim()
  if (!normalized) {
    return ""
  }
  const lower = normalized.toLowerCase()
  if (lower === "new conversation" || lower === "新对话") {
    return ""
  }
  return normalized
}

function readDirectNewTitle(value: unknown): string {
  if (!isRecord(value)) {
    return ""
  }
  return typeof value.newTitle === "string" ? normalizeConversationTitle(value.newTitle) : ""
}

function readStringTitle(value: unknown): string {
  if (!isRecord(value)) {
    return ""
  }
  if (typeof value.title === "string") {
    return normalizeConversationTitle(value.title)
  }
  if (isRecord(value.conversation) && typeof value.conversation.title === "string") {
    return normalizeConversationTitle(value.conversation.title)
  }
  return ""
}

export function extractResponseNewTitleFromRawChunk(rawChunk: unknown): string {
  const candidates = collectRawChunkCandidates(rawChunk)
  for (const candidate of candidates) {
    const nested = readNewTitle(candidate)
    if (nested) {
      return nested
    }
    const direct = readDirectNewTitle(candidate)
    if (direct) {
      return direct
    }
    const stringTitle = readStringTitle(candidate)
    if (stringTitle) {
      return stringTitle
    }
  }

  return ""
}

// ---------------------------------------------------------------------------
// Text delta / final message / response id extraction
// ---------------------------------------------------------------------------

export function extractGatewayTextDeltaFromRawChunk(rawChunk: unknown): string {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (candidate.type === "response.output_text.delta" && typeof candidate.delta === "string") {
      return candidate.delta
    }

    if (typeof candidate.delta === "string") {
      return candidate.delta
    }

    if (typeof candidate.token !== "string") {
      continue
    }

    const messageTag = typeof candidate.messageTag === "string" ? candidate.messageTag.trim().toLowerCase() : ""
    if (messageTag === "header" || messageTag === "tool_usage_card" || messageTag === "raw_function_result") {
      continue
    }
    if (typeof candidate.isThinking === "boolean" && candidate.isThinking && messageTag !== "final") {
      continue
    }
    if (isInternalGatewayJsonToken(candidate.token)) {
      continue
    }
    return candidate.token
  }

  return ""
}

function extractTextFromOutputMessage(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return ""
  }

  const chunks: string[] = []
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
        continue
      }
      chunks.push(part.text)
    }
  }
  return chunks.join("")
}

export function extractGatewayFinalMessageFromRawChunk(rawChunk: unknown): string {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (candidate.type === "response.output_text.done" && typeof candidate.text === "string") {
      return candidate.text
    }

    if (candidate.type === "response.completed") {
      const completedText = extractTextFromOutputMessage(candidate.response)
      if (completedText) {
        return completedText
      }
    }

    const outputText = extractTextFromOutputMessage(candidate)
    if (outputText) {
      return outputText
    }

    if (
      typeof candidate.message === "string" &&
      candidate.message.trim() &&
      !(typeof candidate.sender === "string" && candidate.sender.toLowerCase() === "human") &&
      !isInternalGatewayJsonToken(candidate.message)
    ) {
      return candidate.message
    }
  }

  return ""
}

export function extractGatewayResponseIdFromRawChunk(rawChunk: unknown): string {
  for (const parsed of parseRecords(rawChunk)) {
    const topLevelResponseId =
      normalizeResponseIdCandidate(parsed.response_id) || normalizeResponseIdCandidate(parsed.responseId)
    if (topLevelResponseId) {
      return topLevelResponseId
    }

    const eventType = typeof parsed.type === "string" ? parsed.type.trim() : ""
    if ((eventType === "response.created" || eventType === "response.completed") && isRecord(parsed.response)) {
      const responseObjectId = normalizeResponseIdCandidate(parsed.response.id)
      if (responseObjectId) {
        return responseObjectId
      }
    }

    if (isRecord(parsed.response)) {
      const rootResponseId = readAssistantResponseIdFromGatewayResponse(parsed.response)
      if (rootResponseId) {
        return rootResponseId
      }
    }

    if (isRecord(parsed.result)) {
      if (isRecord(parsed.result.response)) {
        const wrappedResponseId = readAssistantResponseIdFromGatewayResponse(parsed.result.response)
        if (wrappedResponseId) {
          return wrappedResponseId
        }
      }
      if (isRecord(parsed.result.modelResponse)) {
        const wrappedModelResponseId = readExplicitResponseId(parsed.result.modelResponse)
        if (wrappedModelResponseId) {
          return wrappedModelResponseId
        }
      }
    }
  }

  return ""
}

// ---------------------------------------------------------------------------
// Conversation title
// ---------------------------------------------------------------------------

export function resolveConversationTitle(upstreamTitle: string, currentTitle: string): string {
  const upstream = normalizeConversationTitle(upstreamTitle)
  if (upstream) {
    return upstream
  }
  return normalizeConversationTitle(currentTitle)
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function buildConversationId(input: Partial<ChatAnchors>): string {
  if (input.conversationId?.trim()) {
    return input.conversationId.trim()
  }
  if (input.sessionId?.trim()) {
    return input.sessionId.trim()
  }
  return `conv_${crypto.randomUUID()}`
}

export function buildUserMessage(text: string): ChatMessage {
  return {
    id: `usr_${crypto.randomUUID()}`,
    role: "user",
    content: text,
    createdAt: Date.now(),
    status: "completed",
  }
}

/**
 * Extract the `isThinking` boolean from a raw Grok chunk.
 * Returns `true`, `false`, or `null` if not present.
 */
export function extractChunkIsThinking(rawChunk: unknown): boolean | null {
  if (!isRecord(rawChunk)) {
    return null
  }
  // Direct: { isThinking: boolean }
  if (typeof rawChunk.isThinking === "boolean") {
    return rawChunk.isThinking
  }
  // Wrapped: { result: { response: { isThinking: boolean } } }
  const result = isRecord(rawChunk.result) ? rawChunk.result : null
  const response = result && isRecord(result.response) ? result.response : null
  if (response && typeof response.isThinking === "boolean") {
    return response.isThinking
  }
  // Direct response: { response: { isThinking: boolean } }
  const directResponse = isRecord(rawChunk.response) ? rawChunk.response : null
  if (directResponse && typeof directResponse.isThinking === "boolean") {
    return directResponse.isThinking
  }
  return null
}
