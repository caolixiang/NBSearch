import type { ChatAnchors, ChatMessage, SendChatTurnInput } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"
import { buildConversationId, buildUserMessage } from "./chunk-parsers"
import { buildUserMessageText } from "./gateway-turn-request-builder"

export type BootstrappedGatewayTurn = {
  conversationId: string
  anchoredSessionId: string
  sessionId: string
  clientTurnId: string
  regenerateTargetResponseId: string
  isRegenerate: boolean
  fallbackPreviousResponseId: string
  currentTitle: string
  fallbackTitle: string
}

export async function bootstrapGatewayTurn(input: {
  turnInput: SendChatTurnInput
  listConversations: () => Promise<ConversationRecord[]>
  upsertConversation: (record: ConversationRecord) => Promise<void>
  appendMessage: (conversationId: string, message: ChatMessage) => Promise<void>
  createConversationRecord: (
    conversationId: string,
    title: string,
    anchors: Partial<ChatAnchors>,
    now: number
  ) => ConversationRecord
  fallbackConversationTitleFromPrompt: (prompt: string) => string
  now?: () => number
  createSessionId?: () => string
  createClientTurnId?: () => string
}): Promise<BootstrappedGatewayTurn> {
  const now = input.now || (() => Date.now())
  const conversationId = buildConversationId(input.turnInput.anchors)
  const anchoredSessionId = input.turnInput.anchors.sessionId?.trim() || ""
  const sessionId = anchoredSessionId || (input.createSessionId ? input.createSessionId() : `sess_${crypto.randomUUID()}`)
  const clientTurnId =
    input.turnInput.clientTurnId?.trim() ||
    (input.createClientTurnId ? input.createClientTurnId() : `turn_${crypto.randomUUID()}`)
  const regenerateTargetResponseId = input.turnInput.regenerateTargetResponseId?.trim() || ""
  const isRegenerate = regenerateTargetResponseId.length > 0
  const fallbackPreviousResponseId = input.turnInput.anchors.lastResponseId?.trim() || ""
  const existingConversations = await input.listConversations()
  const currentConversation = existingConversations.find((item) => item.id === conversationId)
  const currentTitle = currentConversation?.title || ""
  const fallbackTitle = input.fallbackConversationTitleFromPrompt(input.turnInput.text)

  await input.upsertConversation(
    input.createConversationRecord(
      conversationId,
      currentTitle || fallbackTitle,
      {
        sessionId,
        conversationId,
        lastResponseId: fallbackPreviousResponseId,
      },
      now()
    )
  )

  if (!isRegenerate && !input.turnInput.retryExistingUserMessage) {
    await input.appendMessage(
      conversationId,
      buildUserMessage(buildUserMessageText(input.turnInput.text, input.turnInput.attachments))
    )
  }

  return {
    conversationId,
    anchoredSessionId,
    sessionId,
    clientTurnId,
    regenerateTargetResponseId,
    isRegenerate,
    fallbackPreviousResponseId,
    currentTitle,
    fallbackTitle,
  }
}
