import type { ChatMessage } from "../../../domain/chat/types"
import type {
  AppRepository,
  ConversationRecord,
  VoiceSessionRecord,
} from "../../../domain/storage/repository"

export class MemoryAppRepository implements AppRepository {
  private conversations = new Map<string, ConversationRecord>()
  private messages = new Map<string, ChatMessage[]>()
  private voiceSessions = new Map<string, VoiceSessionRecord>()

  async listConversations(): Promise<ConversationRecord[]> {
    return Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async upsertConversation(record: ConversationRecord): Promise<void> {
    this.conversations.set(record.id, record)
  }

  async updateConversationTitle(conversationId: string, title: string): Promise<void> {
    const current = this.conversations.get(conversationId)
    if (!current) {
      return
    }
    this.conversations.set(conversationId, {
      ...current,
      title,
      updatedAt: Date.now(),
    })
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.conversations.delete(conversationId)
    this.messages.delete(conversationId)
    for (const [id, session] of this.voiceSessions.entries()) {
      if (session.conversationId === conversationId) {
        this.voiceSessions.delete(id)
      }
    }
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<void> {
    const prev = this.messages.get(conversationId) || []
    this.messages.set(conversationId, [...prev, message])
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    return [...(this.messages.get(conversationId) || [])]
  }

  async upsertVoiceSession(record: VoiceSessionRecord): Promise<void> {
    this.voiceSessions.set(record.id, record)
  }
}
