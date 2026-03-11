import type { ChatAnchors, ChatMessage, ChatStreamEvent, SendChatTurnInput } from "./types"

export type ChatSessionAvailability = "available" | "missing" | "unknown"

export interface ChatService {
  streamTurn(
    input: SendChatTurnInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>

  listMessages(conversationId: string): Promise<ChatMessage[]>

  resolveRegenerateTarget(input: {
    conversationId: string
    sessionId: string
    messageId: string
  }): Promise<{
    responseId: string
    previousResponseId: string
  }>

  recoverPendingAssistant(input: {
    conversationId: string
    anchors: Partial<ChatAnchors>
  }): Promise<{
    recovered: boolean
    inProgress?: boolean
    retrySend?: boolean
    previewContent?: string
    result?: {
      assistantMessage: ChatMessage
      anchors: ChatAnchors
    }
  }>

  inspectSessionAvailability(sessionId: string): Promise<ChatSessionAvailability>

  upsertAnchors(anchors: ChatAnchors): Promise<void>
}
