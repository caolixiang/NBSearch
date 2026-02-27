import { streamText, type ModelMessage } from "ai"
import type { AppConfig } from "../../app/contracts"
import type { ChatService } from "../../domain/chat/service"
import type {
  ChatAnchors,
  ChatMessage,
  ChatStreamEvent,
  SendChatTurnInput,
} from "../../domain/chat/types"
import type { AppRepository, ConversationRecord } from "../../domain/storage/repository"
import { GATEWAY_SESSION_ID_METADATA_KEY, ProviderRouter } from "./provider-router"

function buildConversationId(input: Partial<ChatAnchors>): string {
  if (input.conversationId?.trim()) {
    return input.conversationId.trim()
  }
  if (input.sessionId?.trim()) {
    return input.sessionId.trim()
  }
  return `conv_${crypto.randomUUID()}`
}

function buildUserMessage(text: string): ChatMessage {
  return {
    id: `usr_${crypto.randomUUID()}`,
    role: "user",
    content: text,
    createdAt: Date.now(),
    status: "completed",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readNewTitle(value: unknown): string {
  if (!isRecord(value)) {
    return ""
  }
  const title = value.title
  if (!isRecord(title)) {
    return ""
  }
  const newTitle = title.newTitle
  if (typeof newTitle !== "string") {
    return ""
  }
  return newTitle.trim()
}

export function extractResponseNewTitleFromRawChunk(rawChunk: unknown): string {
  if (!isRecord(rawChunk)) {
    return ""
  }
  if (rawChunk.type !== "response.completed") {
    return ""
  }
  const fromResponse = readNewTitle(rawChunk.response)
  if (fromResponse) {
    return fromResponse
  }
  return readNewTitle(rawChunk)
}

export function resolveConversationTitle(upstreamTitle: string, currentTitle: string): string {
  const upstream = upstreamTitle.trim()
  if (upstream) {
    return upstream
  }
  return currentTitle.trim()
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

function toModelMessage(message: ChatMessage): ModelMessage | null {
  if (message.status === "failed") {
    return null
  }

  const content = message.content.trim()
  if (!content) {
    return null
  }

  if (message.role === "user") {
    return {
      role: "user",
      content,
    }
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content,
    }
  }

  if (message.role === "system") {
    return {
      role: "system",
      content,
    }
  }

  return null
}

export function buildAnthropicMessages(history: ChatMessage[]): ModelMessage[] {
  return history
    .map(toModelMessage)
    .filter((item): item is ModelMessage => item !== null)
}

export class AiSdkChatService implements ChatService {
  private readonly router: ProviderRouter

  constructor(
    private readonly repository: AppRepository,
    config: AppConfig
  ) {
    this.router = new ProviderRouter(config)
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
    const history = await this.repository.listMessages(conversationId)

    const resolved = this.router.resolve(input.model)
    const requestId = `req_${crypto.randomUUID()}`
    onEvent({ type: "started", requestId })

    try {
      let upstreamConversationTitle = ""
      const promptInput: { prompt: string } | { messages: ModelMessage[] } =
        resolved.provider === "anthropic"
          ? {
              messages: buildAnthropicMessages(history),
            }
          : {
              prompt: input.text,
            }

      const result = streamText({
        model: resolved.model,
        ...promptInput,
        abortSignal: signal,
        includeRawChunks: resolved.provider === "gateway",
        onChunk: ({ chunk }) => {
          if (chunk.type !== "raw") {
            return
          }
          const nextTitle = extractResponseNewTitleFromRawChunk(chunk.rawValue)
          if (nextTitle) {
            upstreamConversationTitle = nextTitle
          }
        },
        providerOptions:
          resolved.provider === "gateway"
            ? {
                openai: {
                  metadata: {
                    [GATEWAY_SESSION_ID_METADATA_KEY]: sessionId,
                  },
                },
              }
            : undefined,
      })

      let assistantText = ""
      for await (const delta of result.textStream) {
        assistantText += delta
        onEvent({ type: "delta", textDelta: delta })
      }

      const response = await result.response
      const providerMetadata = await result.providerMetadata
      const responseId =
        (providerMetadata as { openai?: { responseId?: string | null } } | undefined)?.openai?.responseId ||
        response.id

      const assistantMessage: ChatMessage = {
        id: responseId || `asst_${crypto.randomUUID()}`,
        role: "assistant",
        content: assistantText,
        createdAt: Date.now(),
        responseId: responseId || undefined,
        previousResponseId: input.anchors.lastResponseId || undefined,
        status: "completed",
      }
      await this.repository.appendMessage(conversationId, assistantMessage)

      const anchors: ChatAnchors = {
        sessionId,
        conversationId,
        lastResponseId: responseId || input.anchors.lastResponseId || "",
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
