import type { ChatAnchors, ChatMessage } from "../chat/types"
import type {
  FeedItemRecord,
  FeedPage,
  FeedPageCursor,
  FeedSource,
  FeedSubscriptionRecord,
} from "../feed/types"

export interface ConversationRecord {
  id: string
  title: string
  starred: boolean
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

  updateConversationTitle(conversationId: string, title: string): Promise<void>

  updateConversationStarred(conversationId: string, starred: boolean): Promise<void>

  deleteConversation(conversationId: string): Promise<void>

  appendMessage(conversationId: string, message: ChatMessage): Promise<void>

  updateMessage(conversationId: string, message: ChatMessage): Promise<void>

  listMessages(conversationId: string): Promise<ChatMessage[]>

  truncateMessagesAfter(
    conversationId: string,
    messageId: string,
    includeMessage?: boolean
  ): Promise<void>

  upsertVoiceSession(record: VoiceSessionRecord): Promise<void>

  getFeedSubscription(source: FeedSource): Promise<FeedSubscriptionRecord | null>

  upsertFeedSubscription(record: FeedSubscriptionRecord): Promise<void>

  listFeedItems(input: {
    source: FeedSource
    limit: number
    cursor?: FeedPageCursor | null
  }): Promise<FeedPage<FeedItemRecord>>

  insertFeedItems(items: FeedItemRecord[]): Promise<number>
}
