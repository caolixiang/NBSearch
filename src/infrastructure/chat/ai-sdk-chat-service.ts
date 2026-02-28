import { streamText, type ModelMessage } from "ai"
import type { AppConfig } from "../../app/contracts"
import type { ChatService } from "../../domain/chat/service"
import type {
  ChatCardAttachmentPayload,
  ChatAnchors,
  ChatMessage,
  ChatReasoningEventDetail,
  ChatReasoningLayout,
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

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value
  }
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed === "[DONE]") {
    return null
  }

  const sseLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const ssePayload = sseLines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
  const rawJson = ssePayload || trimmed
  if (!rawJson || rawJson === "[DONE]") {
    return null
  }
  try {
    const parsed = JSON.parse(rawJson) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

type WebSearchToolMeta = {
  query: string
  numResults: number
}

type AssistantToolMetaPayload = {
  webSearch: WebSearchToolMeta[]
  cards: ChatCardAttachmentPayload[]
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = Math.floor(value)
    return parsed > 0 ? parsed : null
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

function parseFunctionArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value
  }
  if (typeof value !== "string") {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function extractWebSearchToolMetaFromOutputItem(item: unknown): WebSearchToolMeta | null {
  if (!isRecord(item)) {
    return null
  }

  if (item.type !== "function_call" || item.name !== "web_search") {
    return null
  }

  const args = parseFunctionArguments(item.arguments)
  if (!args) {
    return null
  }

  const queryRaw = args.query ?? args.q
  const query = typeof queryRaw === "string" ? queryRaw.trim() : ""
  if (!query) {
    return null
  }

  const numResults =
    toPositiveInteger(args.num_results) ??
    toPositiveInteger(args.result_count) ??
    toPositiveInteger(args.max_results)
  if (!numResults) {
    return null
  }

  return { query, numResults }
}

function extractWebSearchToolMetaFromResponse(response: unknown): WebSearchToolMeta[] {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return []
  }

  const results: WebSearchToolMeta[] = []
  for (const item of response.output) {
    const row = extractWebSearchToolMetaFromOutputItem(item)
    if (row) {
      results.push(row)
    }
  }
  return results
}

export function extractWebSearchToolMetaFromRawChunk(rawChunk: unknown): WebSearchToolMeta[] {
  const parsed = parseRecord(rawChunk)
  if (!parsed) {
    return []
  }

  const eventType = typeof parsed.type === "string" ? parsed.type.trim() : ""
  if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
    const row = extractWebSearchToolMetaFromOutputItem(parsed.item)
    return row ? [row] : []
  }

  if (eventType === "response.completed") {
    const nested = extractWebSearchToolMetaFromResponse(parsed.response)
    if (nested.length > 0) {
      return nested
    }
  }

  const nestedResponse = extractWebSearchToolMetaFromResponse(parsed.response)
  if (nestedResponse.length > 0) {
    return nestedResponse
  }
  return []
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function readReasoningLayout(rawChunk: unknown): {
  layout: ChatReasoningLayout
  isThinking?: boolean
  responseId?: string
} | null {
  const parsed = parseRecord(rawChunk)
  if (!parsed || (parsed.type !== "response.created" && parsed.type !== "response.completed")) {
    return null
  }

  const response = isRecord(parsed.response) ? parsed.response : null
  const uiLayoutFromResponse = response && isRecord(response.uiLayout) ? response.uiLayout : null
  const uiLayout = uiLayoutFromResponse ?? (isRecord(parsed.uiLayout) ? parsed.uiLayout : null)
  if (!uiLayout) {
    return null
  }

  return {
    layout: {
      reasoningUiLayout: typeof uiLayout.reasoningUiLayout === "string" ? uiLayout.reasoningUiLayout : undefined,
      willThinkLong: typeof uiLayout.willThinkLong === "boolean" ? uiLayout.willThinkLong : undefined,
      effort: typeof uiLayout.effort === "string" ? uiLayout.effort : undefined,
      rolloutIds: readStringArray(uiLayout.rolloutIds),
    },
    isThinking: typeof parsed.isThinking === "boolean" ? parsed.isThinking : undefined,
    responseId:
      typeof parsed.responseId === "string"
        ? parsed.responseId
        : typeof parsed.response_id === "string"
          ? parsed.response_id
          : response && typeof response.id === "string"
            ? response.id
          : undefined,
  }
}

function readToolUsageCard(
  value: unknown
): { toolUsageCardId: string; toolName: string; args: Record<string, unknown> } | null {
  if (!isRecord(value)) {
    return null
  }

  const toolUsageCardId =
    typeof value.toolUsageCardId === "string" && value.toolUsageCardId.trim()
      ? value.toolUsageCardId.trim()
      : ""
  if (!toolUsageCardId) {
    return null
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "toolUsageCardId" || !isRecord(nested) || !isRecord(nested.args)) {
      continue
    }
    return {
      toolUsageCardId,
      toolName: key,
      args: nested.args,
    }
  }

  return null
}

function readToolUsageEvent(rawChunk: unknown): ChatReasoningEventDetail | null {
  const parsed = parseRecord(rawChunk)
  if (parsed?.type === "response.output_item.added" && isRecord(parsed.item) && parsed.item.type === "function_call") {
    const args = parseFunctionArguments(parsed.item.arguments) || {}
    const toolUsageCardId =
      typeof parsed.item.call_id === "string" && parsed.item.call_id.trim()
        ? parsed.item.call_id.trim()
        : typeof parsed.item.id === "string" && parsed.item.id.trim()
          ? parsed.item.id.trim()
          : ""
    if (!toolUsageCardId) {
      return null
    }
    return {
      kind: "tool_usage",
      usage: {
        toolUsageCardId,
        toolName: typeof parsed.item.name === "string" ? parsed.item.name : "tool",
        args,
        rolloutId: typeof parsed.item.rollout_id === "string" ? parsed.item.rollout_id : undefined,
        messageTag: typeof parsed.messageTag === "string" ? parsed.messageTag : undefined,
        isThinking: typeof parsed.isThinking === "boolean" ? parsed.isThinking : undefined,
        responseId:
          typeof parsed.responseId === "string"
            ? parsed.responseId
            : typeof parsed.response_id === "string"
              ? parsed.response_id
              : undefined,
      },
    }
  }

  if (parsed?.type !== "response.tool_usage_card") {
    return null
  }

  const toolUsage = readToolUsageCard(parsed.toolUsageCard)
  if (!toolUsage) {
    return null
  }

  return {
    kind: "tool_usage",
    usage: {
      toolUsageCardId: toolUsage.toolUsageCardId,
      toolName: toolUsage.toolName,
      args: toolUsage.args,
      rolloutId: typeof parsed.rolloutId === "string" ? parsed.rolloutId : undefined,
      messageTag: typeof parsed.messageTag === "string" ? parsed.messageTag : undefined,
      isThinking: typeof parsed.isThinking === "boolean" ? parsed.isThinking : undefined,
      responseId:
        typeof parsed.responseId === "string"
          ? parsed.responseId
          : typeof parsed.response_id === "string"
            ? parsed.response_id
            : undefined,
    },
  }
}

function readToolResultEvent(rawChunk: unknown): ChatReasoningEventDetail | null {
  const parsed = parseRecord(rawChunk)
  if (parsed?.type === "response.output_item.done" && isRecord(parsed.item) && parsed.item.type === "function_call") {
    const toolUsageCardId =
      typeof parsed.item.call_id === "string" && parsed.item.call_id.trim()
        ? parsed.item.call_id.trim()
        : typeof parsed.item.id === "string" && parsed.item.id.trim()
          ? parsed.item.id.trim()
          : undefined
    return {
      kind: "tool_result",
      result: {
        toolUsageCardId,
        rolloutId: typeof parsed.item.rollout_id === "string" ? parsed.item.rollout_id : undefined,
        messageTag: typeof parsed.messageTag === "string" ? parsed.messageTag : undefined,
        isThinking: typeof parsed.isThinking === "boolean" ? parsed.isThinking : undefined,
        responseId:
          typeof parsed.responseId === "string"
            ? parsed.responseId
            : typeof parsed.response_id === "string"
              ? parsed.response_id
              : undefined,
      },
    }
  }

  if (
    parsed?.type === "response.tool_usage_card" &&
    typeof parsed.messageTag === "string" &&
    parsed.messageTag === "raw_function_result" &&
    Array.isArray(parsed.webSearchResults)
  ) {
    return {
      kind: "tool_result",
      result: {
        toolUsageCardId: typeof parsed.toolUsageCardId === "string" ? parsed.toolUsageCardId : undefined,
        rolloutId: typeof parsed.rolloutId === "string" ? parsed.rolloutId : undefined,
        messageTag: parsed.messageTag,
        webSearchResultsCount: parsed.webSearchResults.length,
        isThinking: typeof parsed.isThinking === "boolean" ? parsed.isThinking : undefined,
        responseId:
          typeof parsed.responseId === "string"
            ? parsed.responseId
            : typeof parsed.response_id === "string"
              ? parsed.response_id
              : undefined,
      },
    }
  }

  return null
}

function buildGeneratedImageCard(url: string): ChatCardAttachmentPayload {
  const stableId = `generated_image_${encodeURIComponent(url)}`
  return {
    id: stableId,
    cardType: "image_card",
    type: "generated_image",
    url,
    image: {
      original: url,
    },
  }
}

function collectCardAttachmentsFromEnvelope(value: unknown): ChatCardAttachmentPayload[] {
  if (!isRecord(value)) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []

  const imageGeneration = isRecord(value.image_generation) ? value.image_generation : null
  const imageGenerationData = imageGeneration && Array.isArray(imageGeneration.data) ? imageGeneration.data : []
  for (const item of imageGenerationData) {
    if (!isRecord(item) || typeof item.url !== "string") {
      continue
    }
    const url = item.url.trim()
    if (!url) {
      continue
    }
    cards.push(buildGeneratedImageCard(url))
  }

  const responseData = Array.isArray(value.data) ? value.data : []
  for (const item of responseData) {
    if (!isRecord(item) || typeof item.url !== "string") {
      continue
    }
    const url = item.url.trim()
    if (!url) {
      continue
    }
    cards.push(buildGeneratedImageCard(url))
  }

  return cards
}

export function extractCardAttachmentsFromRawChunk(rawChunk: unknown): ChatCardAttachmentPayload[] {
  const parsed = parseRecord(rawChunk)
  if (!parsed) {
    return []
  }

  const nestedResponse = isRecord(parsed.response) ? parsed.response : null
  const candidates = [nestedResponse, parsed]
  const cards: ChatCardAttachmentPayload[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    for (const card of collectCardAttachmentsFromEnvelope(candidate)) {
      if (seen.has(card.id)) {
        continue
      }
      seen.add(card.id)
      cards.push(card)
    }
  }

  return cards
}

export function extractReasoningEventsFromRawChunk(rawChunk: unknown): ChatReasoningEventDetail[] {
  const events: ChatReasoningEventDetail[] = []

  const layout = readReasoningLayout(rawChunk)
  if (layout) {
    events.push({
      kind: "ui_layout",
      layout: layout.layout,
      isThinking: layout.isThinking,
      responseId: layout.responseId,
    })
  }

  const toolUsage = readToolUsageEvent(rawChunk)
  if (toolUsage) {
    events.push(toolUsage)
  }

  const toolResult = readToolResultEvent(rawChunk)
  if (toolResult) {
    events.push(toolResult)
  }

  for (const card of extractCardAttachmentsFromRawChunk(rawChunk)) {
    events.push({
      kind: "card_attachment",
      card,
    })
  }

  return events
}

function appendToolMeta(content: string, payload: AssistantToolMetaPayload): string {
  if (payload.webSearch.length === 0 && payload.cards.length === 0) {
    return content
  }
  const metaPayload = JSON.stringify(payload)
  return `${content}\n<tool-meta>${metaPayload}</tool-meta>`
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

function readDirectNewTitle(value: unknown): string {
  if (!isRecord(value)) {
    return ""
  }
  return typeof value.newTitle === "string" ? value.newTitle.trim() : ""
}

export function extractResponseNewTitleFromRawChunk(rawChunk: unknown): string {
  const parsed = parseRecord(rawChunk)
  if (!parsed) {
    return ""
  }

  const candidates = [parsed.response, parsed]

  for (const candidate of candidates) {
    const nested = readNewTitle(candidate)
    if (nested) {
      return nested
    }
    const direct = readDirectNewTitle(candidate)
    if (direct) {
      return direct
    }
  }

  return ""
}

export function extractGatewayTextDeltaFromRawChunk(rawChunk: unknown): string {
  const parsed = parseRecord(rawChunk)
  if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string") {
    return parsed.delta
  }
  return ""
}

function extractTextFromOutputMessage(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return ""
  }

  const chunks: string[] = []
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
        continue
      }
      chunks.push(part.text)
    }
  }
  return chunks.join("")
}

export function extractGatewayFinalMessageFromRawChunk(rawChunk: unknown): string {
  const parsed = parseRecord(rawChunk)
  if (parsed?.type === "response.output_text.done" && typeof parsed.text === "string") {
    return parsed.text
  }
  if (parsed?.type === "response.completed") {
    const completedText = extractTextFromOutputMessage(parsed.response)
    if (completedText) {
      return completedText
    }
  }
  return ""
}

export function extractGatewayResponseIdFromRawChunk(rawChunk: unknown): string {
  const parsed = parseRecord(rawChunk)
  if (parsed) {
    const responseIdCamel = typeof parsed.responseId === "string" ? parsed.responseId.trim() : ""
    if (responseIdCamel) {
      return responseIdCamel
    }

    const responseId = typeof parsed.response_id === "string" ? parsed.response_id.trim() : ""
    if (responseId) {
      return responseId
    }
    if (isRecord(parsed.response) && typeof parsed.response.id === "string" && parsed.response.id.trim()) {
      return parsed.response.id.trim()
    }
  }

  return ""
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
      let assistantText = ""
      let gatewayResponseId = ""
      let gatewayFinalMessage = ""
      let sawGatewayTextDelta = false
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

          if (resolved.provider === "gateway") {
            const delta = extractGatewayTextDeltaFromRawChunk(chunk.rawValue)
            if (delta) {
              sawGatewayTextDelta = true
              assistantText += delta
              onEvent({ type: "delta", textDelta: delta })
            }

            const nextResponseId = extractGatewayResponseIdFromRawChunk(chunk.rawValue)
            if (nextResponseId) {
              gatewayResponseId = nextResponseId
            }

            const nextFinalMessage = extractGatewayFinalMessageFromRawChunk(chunk.rawValue)
            if (nextFinalMessage) {
              gatewayFinalMessage = nextFinalMessage
            }
          }

          const nextTitle = extractResponseNewTitleFromRawChunk(chunk.rawValue)
          if (nextTitle) {
            upstreamConversationTitle = nextTitle
          }
          appendWebSearchMeta(extractWebSearchToolMetaFromRawChunk(chunk.rawValue))
          appendCards(extractCardAttachmentsFromRawChunk(chunk.rawValue))
          const reasoningEvents = extractReasoningEventsFromRawChunk(chunk.rawValue)
          for (const detail of reasoningEvents) {
            onEvent({
              type: "reasoning",
              detail,
            })
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

      for await (const delta of result.textStream) {
        if (resolved.provider === "gateway" && sawGatewayTextDelta) {
          continue
        }
        assistantText += delta
        onEvent({ type: "delta", textDelta: delta })
      }

      let responseId = gatewayResponseId
      let response: Awaited<typeof result.response> | null = null

      if (resolved.provider === "gateway") {
        if (!assistantText && gatewayFinalMessage) {
          assistantText = gatewayFinalMessage
        }
      } else {
        response = await result.response
        const providerMetadata = await result.providerMetadata
        responseId =
          (providerMetadata as { openai?: { responseId?: string | null } } | undefined)?.openai?.responseId ||
          response.id
        appendWebSearchMeta(extractWebSearchToolMetaFromResponse(response as unknown))
        appendCards(extractCardAttachmentsFromRawChunk(response as unknown))
      }

      const assistantContent = appendToolMeta(assistantText, {
        webSearch: collectedWebSearchMeta,
        cards: collectedCards,
      })

      const assistantMessage: ChatMessage = {
        id: responseId || `asst_${crypto.randomUUID()}`,
        role: "assistant",
        content: assistantContent,
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
