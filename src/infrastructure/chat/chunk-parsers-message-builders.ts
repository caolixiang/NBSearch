import type { ChatAnchors, ChatAttachment, ChatMessage } from "../../domain/chat/types"
import { isRecord } from "./chunk-parsers-common"

export function buildConversationId(input: Partial<ChatAnchors>): string {
  if (input.conversationId?.trim()) {
    return input.conversationId.trim()
  }
  if (input.sessionId?.trim()) {
    return input.sessionId.trim()
  }
  return `conv_${crypto.randomUUID()}`
}

export function buildUserMessage(text: string, attachments?: ChatAttachment[]): ChatMessage {
  return {
    id: `usr_${crypto.randomUUID()}`,
    role: "user",
    content: text,
    ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
    createdAt: Date.now(),
    status: "completed",
  }
}

export function extractChunkIsThinking(rawChunk: unknown): boolean | null {
  if (!isRecord(rawChunk)) {
    return null
  }
  if (typeof rawChunk.isThinking === "boolean") {
    return rawChunk.isThinking
  }
  const result = isRecord(rawChunk.result) ? rawChunk.result : null
  const response = result && isRecord(result.response) ? result.response : null
  if (response && typeof response.isThinking === "boolean") {
    return response.isThinking
  }
  const directResponse = isRecord(rawChunk.response) ? rawChunk.response : null
  if (directResponse && typeof directResponse.isThinking === "boolean") {
    return directResponse.isThinking
  }
  return null
}
