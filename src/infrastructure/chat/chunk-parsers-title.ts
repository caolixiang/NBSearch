import { collectRawChunkCandidates, isRecord } from "./chunk-parsers-common"
import type { AssistantToolMetaPayload } from "./chunk-parsers-common"

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

export function resolveConversationTitle(upstreamTitle: string, currentTitle: string): string {
  const upstream = normalizeConversationTitle(upstreamTitle)
  if (upstream) {
    return upstream
  }
  return normalizeConversationTitle(currentTitle)
}
