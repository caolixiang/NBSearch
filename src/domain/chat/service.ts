import type { ChatAnchors, ChatMessage, ChatStreamEvent, SendChatTurnInput } from "./types"

export interface ChatService {
  streamTurn(
    input: SendChatTurnInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>

  listMessages(conversationId: string): Promise<ChatMessage[]>

  recoverPendingAssistant(input: {
    conversationId: string
    anchors: Partial<ChatAnchors>
  }): Promise<{
    recovered: boolean
    inProgress?: boolean
    result?: {
      assistantMessage: ChatMessage
      anchors: ChatAnchors
    }
  }>

  upsertAnchors(anchors: ChatAnchors): Promise<void>
}
