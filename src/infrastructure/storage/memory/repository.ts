import type { ChatMessage } from "../../../domain/chat/types"
import type {
  AppRepository,
  ConversationRecord,
  VoiceSessionRecord,
} from "../../../domain/storage/repository"
import type {
  FeedItemRecord,
  FeedItemTranslationStatus,
  FeedPage,
  FeedPageCursor,
  FeedSource,
  FeedSubscriptionRecord,
} from "../../../domain/feed/types"

export class MemoryAppRepository implements AppRepository {
  private conversations = new Map<string, ConversationRecord>()
  private messages = new Map<string, ChatMessage[]>()
  private voiceSessions = new Map<string, VoiceSessionRecord>()
  private feedSubscriptions = new Map<FeedSource, FeedSubscriptionRecord>()
  private feedItems = new Map<FeedSource, FeedItemRecord[]>()

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

  async updateConversationStarred(conversationId: string, starred: boolean): Promise<void> {
    const current = this.conversations.get(conversationId)
    if (!current) {
      return
    }
    this.conversations.set(conversationId, {
      ...current,
      starred,
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
    return [...(this.messages.get(conversationId) || [])].sort((left, right) => left.createdAt - right.createdAt)
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

  async getFeedSubscription(source: FeedSource): Promise<FeedSubscriptionRecord | null> {
    return this.feedSubscriptions.get(source) || null
  }

  async upsertFeedSubscription(record: FeedSubscriptionRecord): Promise<void> {
    this.feedSubscriptions.set(record.source, record)
  }

  async listFeedItems(input: {
    source: FeedSource
    limit: number
    cursor?: FeedPageCursor | null
  }): Promise<FeedPage<FeedItemRecord>> {
    const list = [...(this.feedItems.get(input.source) || [])].sort((left, right) => {
      if (right.discoveredAt !== left.discoveredAt) {
        return right.discoveredAt - left.discoveredAt
      }
      return right.id.localeCompare(left.id)
    })
    const filtered = input.cursor
      ? list.filter((item) => {
          if (item.discoveredAt < input.cursor!.discoveredAt) {
            return true
          }
          if (item.discoveredAt > input.cursor!.discoveredAt) {
            return false
          }
          return item.id < input.cursor!.id
        })
      : list
    const items = filtered.slice(0, Math.max(1, input.limit))
    const lastItem = items[items.length - 1] || null
    const hasMore = filtered.length > items.length
    return {
      items,
      nextCursor: hasMore && lastItem
        ? {
            discoveredAt: lastItem.discoveredAt,
            id: lastItem.id,
          }
        : null,
    }
  }

  async listExistingFeedItemContentHashes(input: {
    subscriptionId: string
    contentHashes: string[]
  }): Promise<string[]> {
    const candidates = new Set(
      input.contentHashes.map((item) => item.trim()).filter((item) => item.length > 0)
    )
    if (candidates.size === 0) {
      return []
    }
    return Array.from(this.feedItems.values())
      .flat()
      .filter(
        (item) =>
          item.subscriptionId === input.subscriptionId &&
          candidates.has(item.contentHash)
      )
      .map((item) => item.contentHash)
  }

  async listFeedItemsNeedingTranslation(input: {
    source: FeedSource
    limit: number
    excludeContentHashes?: string[]
  }): Promise<FeedItemRecord[]> {
    const excluded = new Set(
      (input.excludeContentHashes || []).map((item) => item.trim()).filter((item) => item.length > 0)
    )
    return [...(this.feedItems.get(input.source) || [])]
      .filter((item) => {
        if (excluded.has(item.contentHash)) {
          return false
        }
        return item.translationStatus !== "translated" || !item.titleZh.trim() || !item.contentMarkdownZh.trim()
      })
      .sort((left, right) => {
        if (right.discoveredAt !== left.discoveredAt) {
          return right.discoveredAt - left.discoveredAt
        }
        return right.id.localeCompare(left.id)
      })
      .slice(0, Math.max(1, input.limit))
  }

  async updateFeedItemTranslations(input: Array<{
    id: string
    titleZh: string
    contentMarkdownZh: string
    translationStatus: FeedItemTranslationStatus
    translationModel: string
    translatedAt: number | null
  }>): Promise<number> {
    if (input.length === 0) {
      return 0
    }
    const updatesById = new Map(input.map((item) => [item.id, item]))
    let updated = 0

    for (const [source, items] of this.feedItems.entries()) {
      let changed = false
      const nextItems = items.map((item) => {
        const update = updatesById.get(item.id)
        if (!update) {
          return item
        }
        changed = true
        updated += 1
        return {
          ...item,
          titleZh: update.titleZh,
          contentMarkdownZh: update.contentMarkdownZh,
          translationStatus: update.translationStatus,
          translationModel: update.translationModel,
          translatedAt: update.translatedAt,
        }
      })
      if (changed) {
        this.feedItems.set(source, nextItems)
      }
    }

    return updated
  }

  async insertFeedItems(items: FeedItemRecord[]): Promise<number> {
    let inserted = 0
    for (const item of items) {
      const current = this.feedItems.get(item.source) || []
      const exists = current.some((candidate) => candidate.id === item.id || candidate.contentHash === item.contentHash)
      if (exists) {
        continue
      }
      this.feedItems.set(item.source, [...current, item])
      inserted += 1
    }
    return inserted
  }
}
