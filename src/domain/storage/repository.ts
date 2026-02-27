import type { ChatAnchors, ChatMessage } from "../chat/types"

export interface ConversationRecord {
  id: string
  title: string
  anchors: Partial<ChatAnchors>
  createdAt: number
  updatedAt: number
}

export interface VoiceSessionRecord {
  id: string
  conversationId: string
  livekitRoom: string
  requestId: string
  status: "issued" | "connected" | "bound" | "closed" | "failed"
  startedAt: number
  endedAt: number | null
}

export interface AppRepository {
  listConversations(): Promise<ConversationRecord[]>

  upsertConversation(record: ConversationRecord): Promise<void>

  appendMessage(conversationId: string, message: ChatMessage): Promise<void>

  listMessages(conversationId: string): Promise<ChatMessage[]>

  upsertVoiceSession(record: VoiceSessionRecord): Promise<void>
}
