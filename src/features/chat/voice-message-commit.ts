import type { ChatMessage, ChatReasoningEventDetail } from "@/domain/chat/types"
import type { AppRepository, ConversationRecord } from "@/domain/storage/repository"

type VoiceMessageRole = "user" | "assistant"

interface CommitVoiceMessageInput {
  repository: AppRepository
  conversationId: string
  fallbackConversation: ConversationRecord | null
  role: VoiceMessageRole
  text: string
  voiceEventKey?: string
  reasoningEvents?: ChatReasoningEventDetail[]
  sessionId?: string
  responseId?: string
  previousResponseId?: string
  upstreamTitle?: string
  defaultTitle?: string
  messageCreatedAt?: number
  now?: number
}

export interface CommitVoiceMessageResult {
  skipped: boolean
  message: ChatMessage | null
  conversation: ConversationRecord
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
  voiceEventKey,
  reasoningEvents,
  sessionId,
  responseId,
  previousResponseId,
  upstreamTitle,
  defaultTitle,
  messageCreatedAt,
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

  const normalizedVoiceEventKey = voiceEventKey?.trim() || ""

  const existingMessage = (() => {
    if (role === "assistant" && responseId?.trim()) {
      return existingMessages.find(
        (item) => item.role === "assistant" && (item.responseId || "").trim() === responseId.trim()
      )
    }
    if (role === "user" && normalizedVoiceEventKey) {
      return existingMessages.find(
        (item) => item.role === "user" && (item.voiceEventKey || "").trim() === normalizedVoiceEventKey
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
  const normalizedMessageCreatedAt =
    typeof messageCreatedAt === "number" && Number.isFinite(messageCreatedAt) && messageCreatedAt > 0
      ? Math.round(messageCreatedAt)
      : existingMessage?.createdAt || commitTime

  const nextTitle = (() => {
    const currentTitle = latestConversation?.title || fallbackConversation?.title || ""
    const normalizedUpstreamTitle = upstreamTitle?.trim() || ""
    const normalizedDefaultTitle = defaultTitle?.trim() || ""
    if (normalizedUpstreamTitle) {
      return normalizedUpstreamTitle
    }
    if (role === "assistant" && !currentTitle.trim() && normalizedDefaultTitle) {
      return normalizedDefaultTitle
    }
    return currentTitle
  })()

  const nextConversation: ConversationRecord = {
    id: conversationId,
    title: nextTitle,
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
    const nextMessage: ChatMessage = {
      ...existingMessage,
      content: normalizedText,
      createdAt: normalizedMessageCreatedAt,
      ...(normalizedVoiceEventKey ? { voiceEventKey: normalizedVoiceEventKey } : {}),
      ...(Array.isArray(reasoningEvents) && reasoningEvents.length > 0 ? { reasoningEvents } : {}),
      ...(role === "assistant" && (responseId || "").trim() ? { responseId: responseId!.trim() } : {}),
      ...(role === "assistant" && (previousResponseId || "").trim()
        ? { previousResponseId: previousResponseId!.trim() }
        : {}),
    }
    const isUnchanged =
      normalizeText(existingMessage.content) === normalizeText(normalizedText) &&
      existingMessage.createdAt === normalizedMessageCreatedAt &&
      (existingMessage.voiceEventKey || "").trim() === normalizedVoiceEventKey &&
      JSON.stringify(existingMessage.reasoningEvents || []) === JSON.stringify(reasoningEvents || [])
    if (!isUnchanged) {
      await repository.updateMessage(conversationId, nextMessage)
      return {
        skipped: false,
        message: nextMessage,
        conversation: nextConversation,
      }
    }
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
    ...(normalizedVoiceEventKey ? { voiceEventKey: normalizedVoiceEventKey } : {}),
    ...(Array.isArray(reasoningEvents) && reasoningEvents.length > 0 ? { reasoningEvents } : {}),
    ...(role === "assistant" && (responseId || "").trim() ? { responseId: responseId!.trim() } : {}),
    ...(role === "assistant" && (previousResponseId || "").trim()
      ? { previousResponseId: previousResponseId!.trim() }
      : {}),
    status: "completed",
    createdAt: normalizedMessageCreatedAt,
  }

  await repository.appendMessage(conversationId, message)

  return {
    skipped: false,
    message,
    conversation: nextConversation,
  }
}
