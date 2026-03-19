import type { ChatAttachment, ChatDeepSearchResearch, ChatMessage, ChatReasoningEventDetail } from "../../../domain/chat/types"
import type {
  FeedItemRecord,
  FeedPage,
  FeedPageCursor,
  FeedSource,
  FeedSubscriptionRecord,
} from "../../../domain/feed/types"
import type {
  AppRepository,
  ConversationRecord,
  VoiceSessionRecord,
} from "../../../domain/storage/repository"
import { getDatabase } from "./database"

type PersistedMessageContent = {
  text: string
  attachments?: ChatAttachment[]
  voiceEventKey?: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningDurationSeconds?: number
  research?: ChatDeepSearchResearch
}

function hasResearchPayload(research: ChatDeepSearchResearch | undefined): boolean {
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
      (Array.isArray(research.inlineCitations) && research.inlineCitations.length > 0) ||
      (research.requestMetadata && Object.keys(research.requestMetadata).length > 0) ||
      (research.uiLayout &&
        ((research.uiLayout.reasoningUiLayout || "").trim() ||
          typeof research.uiLayout.willThinkLong === "boolean" ||
          (research.uiLayout.effort || "").trim() ||
          (Array.isArray(research.uiLayout.rolloutIds) && research.uiLayout.rolloutIds.length > 0)))
  )
}

function normalizeMessageContent(message: ChatMessage): string {
  const payload: PersistedMessageContent = {
    text: message.content || "",
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    payload.attachments = message.attachments
  }

  if (typeof message.voiceEventKey === "string" && message.voiceEventKey.trim()) {
    payload.voiceEventKey = message.voiceEventKey.trim()
  }

  if (Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0) {
    payload.reasoningEvents = message.reasoningEvents
  }

  if (
    typeof message.reasoningDurationSeconds === "number" &&
    Number.isFinite(message.reasoningDurationSeconds) &&
    message.reasoningDurationSeconds > 0
  ) {
    payload.reasoningDurationSeconds = Math.max(1, Math.round(message.reasoningDurationSeconds))
  }

  if (hasResearchPayload(message.research)) {
    payload.research = message.research
  }

  return JSON.stringify(payload)
}

function parseMessageContent(contentJson: string): {
  text: string
  attachments?: ChatAttachment[]
  voiceEventKey?: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningDurationSeconds?: number
  research?: ChatDeepSearchResearch
} {
  const trimmed = contentJson.trim()
  if (!trimmed) {
    return { text: "" }
  }

  try {
    const value = JSON.parse(trimmed) as {
      text?: unknown
      attachments?: unknown
      voiceEventKey?: unknown
      reasoningEvents?: unknown
      reasoningDurationSeconds?: unknown
      research?: unknown
    }
    const text = typeof value?.text === "string" ? value.text : trimmed
    const result: {
      text: string
      attachments?: ChatAttachment[]
      voiceEventKey?: string
      reasoningEvents?: ChatReasoningEventDetail[]
      reasoningDurationSeconds?: number
      research?: ChatDeepSearchResearch
    } = { text }

    if (Array.isArray(value?.attachments)) {
      const attachments = value.attachments
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return null
          }
          const record = item as Record<string, unknown>
          const name = typeof record.name === "string" ? record.name.trim() : ""
          const kind = record.kind === "image" ? "image" : record.kind === "file" ? "file" : ""
          if (!name || !kind) {
            return null
          }
          const extension = typeof record.extension === "string" ? record.extension.trim().toLowerCase() : ""
          const previewImageUrl = typeof record.previewImageUrl === "string" ? record.previewImageUrl.trim() : ""
          return {
            name,
            kind,
            ...(extension ? { extension } : {}),
            ...(previewImageUrl ? { previewImageUrl } : {}),
          } satisfies ChatAttachment
        })
        .filter((item): item is ChatAttachment => Boolean(item))
      if (attachments.length > 0) {
        result.attachments = attachments
      }
    }
    if (typeof value?.voiceEventKey === "string" && value.voiceEventKey.trim()) {
      result.voiceEventKey = value.voiceEventKey.trim()
    }
    if (Array.isArray(value?.reasoningEvents)) {
      result.reasoningEvents = value.reasoningEvents as ChatReasoningEventDetail[]
    }
    if (
      typeof value?.reasoningDurationSeconds === "number" &&
      Number.isFinite(value.reasoningDurationSeconds) &&
      value.reasoningDurationSeconds > 0
    ) {
      result.reasoningDurationSeconds = Math.max(1, Math.round(value.reasoningDurationSeconds))
    }
    if (value?.research && typeof value.research === "object" && !Array.isArray(value.research)) {
      result.research = value.research as ChatDeepSearchResearch
    }
    return result
  } catch {
    return { text: trimmed }
  }
}

export type SqliteMessageRow = {
  id: string
  role: ChatMessage["role"]
  content_json: string
  response_id: string
  previous_response_id: string
  status: "streaming" | "completed" | "failed"
  created_at: number
}

type SqliteFeedSubscriptionRow = {
  id: string
  source: FeedSource
  enabled: number
  poll_interval_minutes: number
  last_polled_at: number | null
  last_success_at: number | null
  last_error: string
  created_at: number
  updated_at: number
}

type SqliteFeedItemRow = {
  id: string
  subscription_id: string
  source: FeedSource
  content_hash: string
  title: string
  content_markdown: string
  media_json: string
  canonical_url: string
  published_at: number | null
  discovered_at: number
  fetched_at: number
}

function parseFeedMediaUrls(mediaJson: string): string[] {
  const trimmed = mediaJson.trim()
  if (!trimmed) {
    return []
  }
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!Array.isArray(value)) {
      return []
    }
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
  } catch {
    return []
  }
}

function serializeFeedMediaUrls(mediaUrls: string[]): string {
  return JSON.stringify(
    Array.from(new Set(mediaUrls.map((item) => item.trim()).filter((item) => item.length > 0)))
  )
}

function hydrateFeedSubscription(row: SqliteFeedSubscriptionRow): FeedSubscriptionRecord {
  return {
    id: row.id,
    source: row.source,
    enabled: Boolean(row.enabled),
    pollIntervalMinutes: row.poll_interval_minutes,
    lastPolledAt: row.last_polled_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hydrateFeedItem(row: SqliteFeedItemRow): FeedItemRecord {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    source: row.source,
    contentHash: row.content_hash,
    title: row.title,
    contentMarkdown: row.content_markdown,
    mediaUrls: parseFeedMediaUrls(row.media_json),
    canonicalUrl: row.canonical_url || "",
    publishedAt: row.published_at,
    discoveredAt: row.discovered_at,
    fetchedAt: row.fetched_at,
  }
}

export function hydrateChatMessagesFromSqliteRows(rows: SqliteMessageRow[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const voiceMessageIndexByEventKey = new Map<string, number>()

  for (const row of rows) {
    const parsedContent = parseMessageContent(row.content_json)
    const message: ChatMessage = {
      id: row.id,
      role: row.role,
      content: parsedContent.text,
      attachments: parsedContent.attachments,
      voiceEventKey: parsedContent.voiceEventKey,
      reasoningEvents: parsedContent.reasoningEvents,
      reasoningDurationSeconds: parsedContent.reasoningDurationSeconds,
      research: parsedContent.research,
      responseId: row.response_id || undefined,
      previousResponseId: row.previous_response_id || undefined,
      status: row.status,
      createdAt: row.created_at,
    }

    const voiceEventKey = message.role === "user" ? (message.voiceEventKey || "").trim() : ""
    if (voiceEventKey) {
      const existingIndex = voiceMessageIndexByEventKey.get(voiceEventKey)
      if (typeof existingIndex === "number") {
        messages[existingIndex] = message
        continue
      }
      voiceMessageIndexByEventKey.set(voiceEventKey, messages.length)
    }

    messages.push(message)
  }

  return messages
}

export class SqliteAppRepository implements AppRepository {
  async listConversations(): Promise<ConversationRecord[]> {
    const db = await getDatabase()
    const rows = await db.select<
      Array<{
        id: string
        title: string
        starred: number
        session_id: string
        conversation_id: string
        last_response_id: string
        created_at: number
        updated_at: number
      }>
    >(
      `SELECT id, title, starred, session_id, conversation_id, last_response_id, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`
    )

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      starred: Boolean(row.starred),
      anchors: {
        sessionId: row.session_id,
        conversationId: row.conversation_id,
        lastResponseId: row.last_response_id,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async upsertConversation(record: ConversationRecord): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `INSERT INTO conversations(id, title, starred, session_id, conversation_id, last_response_id, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         starred=excluded.starred,
         session_id=excluded.session_id,
         conversation_id=excluded.conversation_id,
         last_response_id=excluded.last_response_id,
         updated_at=excluded.updated_at`,
      [
        record.id,
        record.title,
        record.starred ? 1 : 0,
        record.anchors.sessionId || "",
        record.anchors.conversationId || "",
        record.anchors.lastResponseId || "",
        record.createdAt,
        record.updatedAt,
      ]
    )
  }

  async updateConversationTitle(conversationId: string, title: string): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `UPDATE conversations
       SET title = $1, updated_at = $2
       WHERE id = $3`,
      [title, Date.now(), conversationId]
    )
  }

  async updateConversationStarred(conversationId: string, starred: boolean): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `UPDATE conversations
       SET starred = $1
       WHERE id = $2`,
      [starred ? 1 : 0, conversationId]
    )
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const db = await getDatabase()
    await db.execute(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId])
    await db.execute(`DELETE FROM voice_sessions WHERE conversation_id = $1`, [conversationId])
    await db.execute(`DELETE FROM conversations WHERE id = $1`, [conversationId])
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `INSERT INTO messages(id, conversation_id, role, content_json, response_id, previous_response_id, status, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        message.id,
        conversationId,
        message.role,
        normalizeMessageContent(message),
        message.responseId || "",
        message.previousResponseId || "",
        message.status || "completed",
        message.createdAt,
      ]
    )
  }

  async updateMessage(conversationId: string, message: ChatMessage): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `UPDATE messages
       SET role = $1,
           content_json = $2,
           response_id = $3,
           previous_response_id = $4,
           status = $5,
           created_at = $6
       WHERE conversation_id = $7 AND id = $8`,
      [
        message.role,
        normalizeMessageContent(message),
        message.responseId || "",
        message.previousResponseId || "",
        message.status || "completed",
        message.createdAt,
        conversationId,
        message.id,
      ]
    )
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const db = await getDatabase()
    const rows = await db.select<SqliteMessageRow[]>(
      `SELECT id, role, content_json, response_id, previous_response_id, status, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, rowid ASC`,
      [conversationId]
    )

    return hydrateChatMessagesFromSqliteRows(rows)
  }

  async truncateMessagesAfter(
    conversationId: string,
    messageId: string,
    includeMessage = false
  ): Promise<void> {
    const db = await getDatabase()
    const operator = includeMessage ? ">=" : ">"
    await db.execute(
      `DELETE FROM messages
       WHERE conversation_id = $1
         AND rowid ${operator} (
           SELECT rowid
           FROM messages
           WHERE conversation_id = $1 AND id = $2
           ORDER BY rowid DESC
           LIMIT 1
         )`,
      [conversationId, messageId]
    )
  }

  async upsertVoiceSession(record: VoiceSessionRecord): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `INSERT INTO voice_sessions(id, conversation_id, livekit_room, request_id, status, started_at, ended_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET
         conversation_id=excluded.conversation_id,
         livekit_room=excluded.livekit_room,
         request_id=excluded.request_id,
         status=excluded.status,
         started_at=excluded.started_at,
         ended_at=excluded.ended_at`,
      [
        record.id,
        record.conversationId,
        record.livekitRoom,
        record.requestId,
        record.status,
        record.startedAt,
        record.endedAt,
      ]
    )
  }

  async getFeedSubscription(source: FeedSource): Promise<FeedSubscriptionRecord | null> {
    const db = await getDatabase()
    const rows = await db.select<SqliteFeedSubscriptionRow[]>(
      `SELECT id, source, enabled, poll_interval_minutes, last_polled_at, last_success_at, last_error, created_at, updated_at
       FROM feed_subscriptions
       WHERE source = $1
       LIMIT 1`,
      [source]
    )
    const row = rows[0]
    return row ? hydrateFeedSubscription(row) : null
  }

  async upsertFeedSubscription(record: FeedSubscriptionRecord): Promise<void> {
    const db = await getDatabase()
    await db.execute(
      `INSERT INTO feed_subscriptions(
         id, source, enabled, poll_interval_minutes, last_polled_at, last_success_at, last_error, created_at, updated_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(source) DO UPDATE SET
         id=excluded.id,
         enabled=excluded.enabled,
         poll_interval_minutes=excluded.poll_interval_minutes,
         last_polled_at=excluded.last_polled_at,
         last_success_at=excluded.last_success_at,
         last_error=excluded.last_error,
         updated_at=excluded.updated_at`,
      [
        record.id,
        record.source,
        record.enabled ? 1 : 0,
        record.pollIntervalMinutes,
        record.lastPolledAt,
        record.lastSuccessAt,
        record.lastError || "",
        record.createdAt,
        record.updatedAt,
      ]
    )
  }

  async listFeedItems(input: {
    source: FeedSource
    limit: number
    cursor?: FeedPageCursor | null
  }): Promise<FeedPage<FeedItemRecord>> {
    const db = await getDatabase()
    const limit = Math.max(1, Math.floor(input.limit))
    const rows = input.cursor
      ? await db.select<SqliteFeedItemRow[]>(
          `SELECT id, subscription_id, source, content_hash, title, content_markdown, media_json, canonical_url, published_at, discovered_at, fetched_at
           FROM feed_items
           WHERE source = $1
             AND (
               discovered_at < $2
               OR (discovered_at = $2 AND id < $3)
             )
           ORDER BY discovered_at DESC, id DESC
           LIMIT $4`,
          [input.source, input.cursor.discoveredAt, input.cursor.id, limit + 1]
        )
      : await db.select<SqliteFeedItemRow[]>(
          `SELECT id, subscription_id, source, content_hash, title, content_markdown, media_json, canonical_url, published_at, discovered_at, fetched_at
           FROM feed_items
           WHERE source = $1
           ORDER BY discovered_at DESC, id DESC
           LIMIT $2`,
          [input.source, limit + 1]
        )

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = pageRows.map(hydrateFeedItem)
    const lastItem = items[items.length - 1] || null

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

  async insertFeedItems(items: FeedItemRecord[]): Promise<number> {
    if (items.length === 0) {
      return 0
    }
    const db = await getDatabase()
    let inserted = 0
    for (const item of items) {
      const result = await db.execute(
        `INSERT OR IGNORE INTO feed_items(
           id, subscription_id, source, content_hash, title, content_markdown, media_json, canonical_url, published_at, discovered_at, fetched_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          item.id,
          item.subscriptionId,
          item.source,
          item.contentHash,
          item.title,
          item.contentMarkdown,
          serializeFeedMediaUrls(item.mediaUrls),
          item.canonicalUrl || "",
          item.publishedAt,
          item.discoveredAt,
          item.fetchedAt,
        ]
      )
      inserted += result.rowsAffected
    }
    return inserted
  }
}
