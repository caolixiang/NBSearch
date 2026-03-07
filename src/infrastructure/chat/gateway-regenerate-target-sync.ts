import type { ChatMessage } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"
import type { GatewaySessionMessage, GatewaySessionState } from "./gateway-session-recovery"
import { resolveGatewayRegenerateTarget } from "./gateway-regenerate-target-resolver"
import { fallbackConversationTitleFromPrompt } from "./gateway-conversation-persistence"

export async function syncGatewayRegenerateTarget(input: {
  conversationId: string
  sessionId: string
  messageId: string
  listMessages: (conversationId: string) => Promise<ChatMessage[]>
  updateMessage: (conversationId: string, message: ChatMessage) => Promise<void>
  listConversations: () => Promise<ConversationRecord[]>
  upsertConversation: (record: ConversationRecord) => Promise<void>
  querySessionMessages: (afterResponseId: string) => Promise<GatewaySessionMessage[]>
  querySessionState: () => Promise<GatewaySessionState | null>
  now?: () => number
}): Promise<{
  responseId: string
  previousResponseId: string
}> {
  const conversationId = (input.conversationId || "").trim()
  const sessionId = (input.sessionId || "").trim()
  const messageId = (input.messageId || "").trim()
  if (!conversationId || !sessionId || !messageId) {
    return {
      responseId: "",
      previousResponseId: "",
    }
  }

  const localMessages = await input.listMessages(conversationId).catch(() => [])
  const targetMessage = localMessages.find((row) => row.id === messageId && row.role === "assistant")
  if (!targetMessage || targetMessage.role !== "assistant") {
    return {
      responseId: "",
      previousResponseId: "",
    }
  }

  const sessionMessages = await input.querySessionMessages("")
  const { matchedAssistant, resolvedResponseId, resolvedPreviousResponseId } =
    resolveGatewayRegenerateTarget({
      localMessages,
      sessionMessages,
      messageId,
    })

  const currentResponseId = targetMessage.responseId?.trim() || ""
  const currentPreviousResponseId = targetMessage.previousResponseId?.trim() || ""
  if (
    matchedAssistant &&
    (resolvedResponseId !== currentResponseId || resolvedPreviousResponseId !== currentPreviousResponseId)
  ) {
    await input.updateMessage(conversationId, {
      ...targetMessage,
      responseId: resolvedResponseId || undefined,
      previousResponseId: resolvedPreviousResponseId || undefined,
    })
  }

  const sessionState = await input.querySessionState()
  const lastResponseId = sessionState?.lastResponseId.trim() || ""
  if (lastResponseId) {
    const existingConversations = await input.listConversations()
    const currentConversation = existingConversations.find((item) => item.id === conversationId)
    const now = input.now || (() => Date.now())
    await input.upsertConversation({
      id: conversationId,
      title: currentConversation?.title || fallbackConversationTitleFromPrompt(targetMessage.content),
      anchors: {
        sessionId,
        conversationId,
        lastResponseId,
      },
      createdAt: currentConversation?.createdAt || now(),
      updatedAt: now(),
    })
  }

  return {
    responseId: resolvedResponseId,
    previousResponseId: resolvedPreviousResponseId,
  }
}
