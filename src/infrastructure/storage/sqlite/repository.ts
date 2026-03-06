import type { ChatDeepSearchResearch, ChatMessage, ChatReasoningEventDetail } from "../../../domain/chat/types"
import type {
  AppRepository,
  ConversationRecord,
  VoiceSessionRecord,
} from "../../../domain/storage/repository"
import { getDatabase } from "./database"

type PersistedMessageContent = {
  text: string
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
      reasoningEvents?: unknown
      reasoningDurationSeconds?: unknown
      research?: unknown
    }
    const text = typeof value?.text === "string" ? value.text : trimmed
    const result: {
      text: string
      reasoningEvents?: ChatReasoningEventDetail[]
      reasoningDurationSeconds?: number
      research?: ChatDeepSearchResearch
    } = { text }

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

export class SqliteAppRepository implements AppRepository {
  async listConversations(): Promise<ConversationRecord[]> {
    const db = await getDatabase()
    const rows = await db.select<
      Array<{
        id: string
        title: string
        session_id: string
        conversation_id: string
        last_response_id: string
        created_at: number
        updated_at: number
      }>
    >(
      `SELECT id, title, session_id, conversation_id, last_response_id, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC`
    )

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
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
      `INSERT INTO conversations(id, title, session_id, conversation_id, last_response_id, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         session_id=excluded.session_id,
         conversation_id=excluded.conversation_id,
         last_response_id=excluded.last_response_id,
         updated_at=excluded.updated_at`,
      [
        record.id,
        record.title,
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
    const rows = await db.select<
      Array<{
        id: string
        role: ChatMessage["role"]
        content_json: string
        response_id: string
        previous_response_id: string
        status: "streaming" | "completed" | "failed"
        created_at: number
      }>
    >(
      `SELECT id, role, content_json, response_id, previous_response_id, status, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, rowid ASC`,
      [conversationId]
    )

    return rows.map((row) => {
      const parsedContent = parseMessageContent(row.content_json)
      return {
        id: row.id,
        role: row.role,
        content: parsedContent.text,
        reasoningEvents: parsedContent.reasoningEvents,
        reasoningDurationSeconds: parsedContent.reasoningDurationSeconds,
        research: parsedContent.research,
        responseId: row.response_id || undefined,
        previousResponseId: row.previous_response_id || undefined,
        status: row.status,
        createdAt: row.created_at,
      }
    })
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
}
