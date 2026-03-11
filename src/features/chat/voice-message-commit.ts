import type { ChatMessage } from "@/domain/chat/types"
import type { AppRepository, ConversationRecord } from "@/domain/storage/repository"

type VoiceMessageRole = "user" | "assistant"

interface CommitVoiceMessageInput {
  repository: AppRepository
  conversationId: string
  fallbackConversation: ConversationRecord | null
  role: VoiceMessageRole
  text: string
  sessionId?: string
  responseId?: string
  previousResponseId?: string
  now?: number
}

export interface CommitVoiceMessageResult {
  skipped: boolean
  message: ChatMessage | null
  conversation: ConversationRecord
}

function fallbackConversationTitleFromText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) {
    return ""
  }
  return firstLine.length <= 48 ? firstLine : `${firstLine.slice(0, 48).trim()}...`
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export async function commitVoiceMessage({
  repository,
  conversationId,
  fallbackConversation,
  role,
  text,
  sessionId,
  responseId,
  previousResponseId,
  now,
}: CommitVoiceMessageInput): Promise<CommitVoiceMessageResult> {
  const normalizedText = text.trim()
  if (!normalizedText) {
    throw new Error("voice message text is required")
  }

  const commitTime = now ?? Date.now()
  const [latestConversations, existingMessages] = await Promise.all([
    repository.listConversations(),
    repository.listMessages(conversationId).catch(() => []),
  ])
  const latestConversation =
    latestConversations.find((item) => item.id === conversationId) || fallbackConversation

  const existingMessage = (() => {
    if (role === "assistant" && responseId?.trim()) {
      return existingMessages.find(
        (item) => item.role === "assistant" && (item.responseId || "").trim() === responseId.trim()
      )
    }
    const lastMessage = existingMessages[existingMessages.length - 1]
    if (!lastMessage || lastMessage.role !== role) {
      return null
    }
    const sameText = normalizeText(lastMessage.content) === normalizeText(normalizedText)
    const samePreviousResponseId =
      role === "assistant"
        ? (lastMessage.previousResponseId || "").trim() === (previousResponseId || "").trim()
        : true
    return sameText && samePreviousResponseId ? lastMessage : null
  })()

  const nextConversation: ConversationRecord = {
    id: conversationId,
    title:
      latestConversation?.title ||
      fallbackConversation?.title ||
      (role === "user" ? fallbackConversationTitleFromText(normalizedText) : ""),
    anchors: {
      ...(latestConversation?.anchors || fallbackConversation?.anchors || {}),
      conversationId,
      ...((sessionId || "").trim() ? { sessionId: sessionId!.trim() } : {}),
      ...(role === "assistant" && (responseId || "").trim()
        ? { lastResponseId: responseId!.trim() }
        : {}),
    },
    createdAt: latestConversation?.createdAt || fallbackConversation?.createdAt || commitTime,
    updatedAt: commitTime,
  }

  await repository.upsertConversation(nextConversation)

  if (existingMessage) {
    return {
      skipped: true,
      message: existingMessage,
      conversation: nextConversation,
    }
  }

  const message: ChatMessage = {
    id: `${role === "user" ? "voice_usr" : "voice_asst"}_${crypto.randomUUID()}`,
    role,
    content: normalizedText,
    ...(role === "assistant" && (responseId || "").trim() ? { responseId: responseId!.trim() } : {}),
    ...(role === "assistant" && (previousResponseId || "").trim()
      ? { previousResponseId: previousResponseId!.trim() }
      : {}),
    status: "completed",
    createdAt: commitTime,
  }

  await repository.appendMessage(conversationId, message)

  return {
    skipped: false,
    message,
    conversation: nextConversation,
  }
}
