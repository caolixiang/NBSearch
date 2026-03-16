import type { ChatAnchors, ChatMessage } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"

export function createConversationRecord(
  conversationId: string,
  title: string,
  anchors: Partial<ChatAnchors>,
  now: number,
  starred = false
): ConversationRecord {
  return {
    id: conversationId,
    title,
    starred,
    anchors,
    createdAt: now,
    updatedAt: now,
  }
}

export function fallbackConversationTitleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) {
    return ""
  }
  const maxLength = 48
  if (firstLine.length <= maxLength) {
    return firstLine
  }
  return `${firstLine.slice(0, maxLength).trim()}...`
}

export async function persistGatewayAssistantTurn(input: {
  conversationId: string
  assistantMessage: ChatMessage
  anchors: ChatAnchors
  resolvedTitle: string
  commitTime: number
  regenerateTargetResponseId?: string
  listConversations: () => Promise<ConversationRecord[]>
  listMessages: (conversationId: string) => Promise<ChatMessage[]>
  truncateMessagesAfter: (
    conversationId: string,
    messageId: string,
    includeMessage?: boolean
  ) => Promise<void>
  appendMessage: (conversationId: string, message: ChatMessage) => Promise<void>
  upsertConversation: (record: ConversationRecord) => Promise<void>
}): Promise<void> {
  const regenerateTargetResponseId = input.regenerateTargetResponseId?.trim() || ""
  const existingConversations = await input.listConversations().catch(() => [])
  const currentConversation = existingConversations.find((item) => item.id === input.conversationId)
  if (regenerateTargetResponseId) {
    const existingMessages = await input.listMessages(input.conversationId).catch(() => [])
    const targetAssistant = existingMessages.find(
      (row) =>
        row.role === "assistant" &&
        ((((row.responseId || "").trim() && (row.responseId || "").trim() === regenerateTargetResponseId) ||
          row.id === regenerateTargetResponseId))
    )
    if (targetAssistant) {
      await input.truncateMessagesAfter(input.conversationId, targetAssistant.id, true)
    }
  }

  await input.appendMessage(input.conversationId, input.assistantMessage)
  await input.upsertConversation(
    createConversationRecord(
      input.conversationId,
      input.resolvedTitle,
      input.anchors,
      input.commitTime,
      currentConversation?.starred === true
    )
  )
}

export async function upsertGatewayConversationAnchors(input: {
  anchors: ChatAnchors
  listConversations: () => Promise<ConversationRecord[]>
  upsertConversation: (record: ConversationRecord) => Promise<void>
  now?: () => number
  createConversationId?: () => string
}): Promise<void> {
  const now = input.now || (() => Date.now())
  const conversationId =
    input.anchors.conversationId ||
    input.anchors.sessionId ||
    (input.createConversationId ? input.createConversationId() : `conv_${crypto.randomUUID()}`)
  const existingConversations = await input.listConversations()
  const currentConversation = existingConversations.find((item) => item.id === conversationId)
  const currentTitle = currentConversation?.title || ""
  await input.upsertConversation({
    id: conversationId,
    title: currentTitle,
    starred: currentConversation?.starred === true,
    anchors: input.anchors,
    createdAt: now(),
    updatedAt: now(),
  })
}
