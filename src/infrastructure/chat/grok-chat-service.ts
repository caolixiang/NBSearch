import type { AppConfig } from "../../app/contracts"
import type { ChatService } from "../../domain/chat/service"
import type {
  ChatAnchors,
  ChatCardAttachmentPayload,
  ChatMessage,
  ChatStreamEvent,
  SendChatTurnInput,
} from "../../domain/chat/types"
import type { AppRepository, ConversationRecord } from "../../domain/storage/repository"
import { createRuntimeFetch } from "../http/runtime-fetch"
import {
  type AssistantToolMetaPayload,
  type WebSearchToolMeta,
  appendToolMeta,
  buildConversationId,
  buildUserMessage,
  extractCardAttachmentsFromRawChunk,
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractReasoningEventsFromRawChunk,
  extractResponseNewTitleFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
  parseJsonObjectStrings,
  resolveConversationTitle,
} from "./chunk-parsers"

function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) {
    return "http://localhost:8787/v1/responses"
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/responses`
  }
  return `${trimmed}/v1/responses`
}

/**
 * Normalize the API base URL to the /v1 path (for model catalog etc.)
 */
export function normalizeGatewayBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) {
    return "http://localhost:8787/v1"
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  if (trimmed.endsWith("/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  return `${trimmed}/v1`
}

function createConversationRecord(
  conversationId: string,
  title: string,
  anchors: Partial<ChatAnchors>,
  now: number
): ConversationRecord {
  return {
    id: conversationId,
    title,
    anchors,
    createdAt: now,
    updatedAt: now,
  }
}

export class GrokChatService implements ChatService {
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly runtimeFetch: typeof fetch

  constructor(
    private readonly repository: AppRepository,
    config: AppConfig
  ) {
    this.apiUrl = normalizeApiBaseUrl(config.apiBaseUrl)
    this.apiKey = config.apiKey || ""
    this.runtimeFetch = createRuntimeFetch(fetch)
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    return this.repository.listMessages(conversationId)
  }

  async upsertAnchors(anchors: ChatAnchors): Promise<void> {
    const now = Date.now()
    const conversationId = anchors.conversationId || anchors.sessionId || `conv_${crypto.randomUUID()}`
    const existingConversations = await this.repository.listConversations()
    const currentTitle = existingConversations.find((item) => item.id === conversationId)?.title || ""
    await this.repository.upsertConversation({
      id: conversationId,
      title: currentTitle,
      anchors,
      createdAt: now,
      updatedAt: now,
    })
  }

  async streamTurn(
    input: SendChatTurnInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const conversationId = buildConversationId(input.anchors)
    const sessionId = input.anchors.sessionId?.trim() || `sess_${crypto.randomUUID()}`
    const userMessage = buildUserMessage(input.text)

    await this.repository.appendMessage(conversationId, userMessage)

    const requestId = `req_${crypto.randomUUID()}`
    onEvent({ type: "started", requestId })

    try {
      const requestBody = JSON.stringify({
        model: input.model,
        input: input.text,
        session_id: sessionId,
        stream: true,
      })

      const response = await this.runtimeFetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: requestBody,
        signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        onEvent({
          type: "failed",
          code: `http_${response.status}`,
          message: errorText || `HTTP ${response.status}`,
        })
        return
      }

      if (!response.body) {
        onEvent({
          type: "failed",
          code: "no_body",
          message: "Response has no body",
        })
        return
      }

      let upstreamConversationTitle = ""
      let assistantText = ""
      let gatewayResponseId = ""
      let gatewayFinalMessage = ""
      const collectedWebSearchMeta: WebSearchToolMeta[] = []
      const collectedWebSearchSeen = new Set<string>()
      const collectedCards: ChatCardAttachmentPayload[] = []
      const collectedCardIds = new Set<string>()

      const appendWebSearchMeta = (items: WebSearchToolMeta[]) => {
        for (const item of items) {
          const dedupeKey = `${item.query}\u0000${item.numResults}`
          if (collectedWebSearchSeen.has(dedupeKey)) {
            continue
          }
          collectedWebSearchSeen.add(dedupeKey)
          collectedWebSearchMeta.push(item)
        }
      }

      const appendCards = (items: ChatCardAttachmentPayload[]) => {
        for (const item of items) {
          if (collectedCardIds.has(item.id)) {
            continue
          }
          collectedCardIds.add(item.id)
          collectedCards.push(item)
        }
      }

      // Read the streaming response as concatenated JSON objects
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })

          // Parse complete JSON objects from the buffer
          const segments = parseJsonObjectStrings(buffer)
          if (segments.length === 0) {
            continue
          }

          // Find the position of the last parsed segment to trim the buffer
          let lastEnd = 0
          for (const segment of segments) {
            const idx = buffer.indexOf(segment, lastEnd)
            if (idx >= 0) {
              lastEnd = idx + segment.length
            }
          }
          buffer = buffer.slice(lastEnd)

          // Process each parsed JSON object
          for (const segment of segments) {
            let parsed: unknown
            try {
              parsed = JSON.parse(segment)
            } catch {
              continue
            }

            // Extract text delta
            const delta = extractGatewayTextDeltaFromRawChunk(parsed)
            if (delta) {
              assistantText += delta
              onEvent({ type: "delta", textDelta: delta })
            }

            // Extract response ID
            const nextResponseId = extractGatewayResponseIdFromRawChunk(parsed)
            if (nextResponseId) {
              gatewayResponseId = nextResponseId
            }

            // Extract final message
            const nextFinalMessage = extractGatewayFinalMessageFromRawChunk(parsed)
            if (nextFinalMessage) {
              gatewayFinalMessage = nextFinalMessage
            }

            // Extract title
            const nextTitle = extractResponseNewTitleFromRawChunk(parsed)
            if (nextTitle) {
              upstreamConversationTitle = nextTitle
            }

            // Extract web search meta & cards
            appendWebSearchMeta(extractWebSearchToolMetaFromRawChunk(parsed))
            appendCards(extractCardAttachmentsFromRawChunk(parsed))

            // Extract reasoning events
            const reasoningEvents = extractReasoningEventsFromRawChunk(parsed)
            for (const detail of reasoningEvents) {
              onEvent({ type: "reasoning", detail })
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      // Use final message as fallback if no accumulated text
      if (!assistantText && gatewayFinalMessage) {
        assistantText = gatewayFinalMessage
      }

      const assistantContent = appendToolMeta(assistantText, {
        webSearch: collectedWebSearchMeta,
        cards: collectedCards,
      })

      const assistantMessage: ChatMessage = {
        id: gatewayResponseId || `asst_${crypto.randomUUID()}`,
        role: "assistant",
        content: assistantContent,
        createdAt: Date.now(),
        responseId: gatewayResponseId || undefined,
        previousResponseId: input.anchors.lastResponseId || undefined,
        status: "completed",
      }
      await this.repository.appendMessage(conversationId, assistantMessage)

      const anchors: ChatAnchors = {
        sessionId,
        conversationId,
        lastResponseId: gatewayResponseId || input.anchors.lastResponseId || "",
      }
      const existingConversations = await this.repository.listConversations()
      const currentTitle = existingConversations.find((item) => item.id === conversationId)?.title || ""
      await this.repository.upsertConversation(
        createConversationRecord(
          conversationId,
          resolveConversationTitle(upstreamConversationTitle, currentTitle),
          anchors,
          Date.now()
        )
      )

      onEvent({
        type: "completed",
        result: {
          assistantMessage,
          anchors,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error"
      onEvent({
        type: "failed",
        code: "chat_stream_error",
        message,
      })
    }
  }
}
