import type { ChatAnchors, ChatMessage } from "@/domain/chat/types"
import type { AppRepository, ConversationRecord } from "@/domain/storage/repository"

type CommitRegeneratedAssistantMessageInput = {
  repository: AppRepository
  conversationId: string
  targetAssistantId: string
  assistantMessage: ChatMessage
  anchors: Partial<ChatAnchors>
  fallbackConversation: ConversationRecord | null
  now?: number
}

export async function commitRegeneratedAssistantMessage({
  repository,
  conversationId,
  targetAssistantId,
  assistantMessage,
  anchors,
  fallbackConversation,
  now,
}: CommitRegeneratedAssistantMessageInput): Promise<void> {
  await repository.truncateMessagesAfter(conversationId, targetAssistantId, true)
  await repository.appendMessage(conversationId, assistantMessage)

  const commitTime = now ?? Date.now()
  const latestConversations = await repository.listConversations()
  const latestConversation =
    latestConversations.find((item) => item.id === conversationId) || fallbackConversation

  await repository.upsertConversation({
    id: conversationId,
    title: latestConversation?.title || fallbackConversation?.title || "",
    anchors,
    createdAt: latestConversation?.createdAt || fallbackConversation?.createdAt || commitTime,
    updatedAt: commitTime,
  })
}
