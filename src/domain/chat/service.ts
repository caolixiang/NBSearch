import type { ChatAnchors, ChatMessage, ChatStreamEvent, SendChatTurnInput } from "./types"

export interface ChatService {
  streamTurn(
    input: SendChatTurnInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>

  listMessages(conversationId: string): Promise<ChatMessage[]>

  upsertAnchors(anchors: ChatAnchors): Promise<void>
}
