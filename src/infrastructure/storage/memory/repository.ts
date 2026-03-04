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

  private conversationHasDeepSearch(conversationId: string): boolean {
    const messages = this.messages.get(conversationId) || []
    return messages.some((message) => {
      if (message.role !== "assistant") {
        return false
      }
      const research = message.research
      if (!research) {
        return false
      }
      return Boolean(
        (research.deepsearchPreset || "").trim() ||
          (research.thinkingStartTime || "").trim() ||
          (research.thinkingEndTime || "").trim() ||
          (Array.isArray(research.steps) && research.steps.length > 0) ||
          (Array.isArray(research.details) && research.details.length > 0) ||
          (Array.isArray(research.citationCards) && research.citationCards.length > 0) ||
          (Array.isArray(research.inlineCitations) && research.inlineCitations.length > 0)
      )
    })
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return Array.from(this.conversations.values())
      .map((conversation) => ({
        ...conversation,
        hasDeepSearch: this.conversationHasDeepSearch(conversation.id),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
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

  async updateMessage(conversationId: string, message: ChatMessage): Promise<void> {
    const list = this.messages.get(conversationId) || []
    const index = list.findIndex((item) => item.id === message.id)
    if (index < 0) {
      return
    }
    const next = [...list]
    next[index] = message
    this.messages.set(conversationId, next)
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    return [...(this.messages.get(conversationId) || [])]
  }

  async truncateMessagesAfter(
    conversationId: string,
    messageId: string,
    includeMessage = false
  ): Promise<void> {
    const list = this.messages.get(conversationId) || []
    const index = list.findIndex((item) => item.id === messageId)
    if (index < 0) {
      return
    }
    const keepCount = includeMessage ? index : index + 1
    this.messages.set(conversationId, list.slice(0, Math.max(0, keepCount)))
  }

  async upsertVoiceSession(record: VoiceSessionRecord): Promise<void> {
    this.voiceSessions.set(record.id, record)
  }
}
