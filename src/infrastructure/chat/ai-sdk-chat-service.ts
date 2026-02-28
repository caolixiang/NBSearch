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

function parseJsonObjectStrings(raw: string): string[] {
  const input = raw.trim()
  if (!input || input === "[DONE]") {
    return []
  }

  const segments: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (start < 0) {
      if (char === "{") {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "\"") {
      inString = true
      continue
    }
    if (char === "{") {
      depth += 1
      continue
    }
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        segments.push(input.slice(start, index + 1))
        start = -1
      }
    }
  }

  return segments
}

function parseRecords(value: unknown): Record<string, unknown>[] {
  if (isRecord(value)) {
    return [value]
  }
  if (typeof value !== "string") {
    return []
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed === "[DONE]") {
    return []
  }

  const records: Record<string, unknown>[] = []
  for (const candidate of parseJsonObjectStrings(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isRecord(parsed)) {
        records.push(parsed)
      }
    } catch {
      continue
    }
  }
  if (records.length > 0) {
    return records
  }

  const sseLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))

  for (const line of sseLines) {
    const payload = line.slice("data:".length).trim()
    if (!payload || payload === "[DONE]") {
      continue
    }
    for (const candidate of parseJsonObjectStrings(payload)) {
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (isRecord(parsed)) {
          records.push(parsed)
        }
      } catch {
        continue
      }
    }
  }

  return records
}

function collectRawChunkCandidates(rawChunk: unknown): Record<string, unknown>[] {
  const parsedRecords = parseRecords(rawChunk)
  if (parsedRecords.length === 0) {
    return []
  }

  const candidates: Record<string, unknown>[] = []
  const seen = new Set<Record<string, unknown>>()

  const append = (value: unknown) => {
    if (!isRecord(value) || seen.has(value)) {
      return
    }
    seen.add(value)
    candidates.push(value)
  }

  for (const parsed of parsedRecords) {
    append(parsed)
    append(parsed.result)
    append(parsed.response)

    if (isRecord(parsed.result)) {
      append(parsed.result.response)
      append(parsed.result.title)
    }
  }

  return candidates
}

function extractResponseIdFromRecord(value: Record<string, unknown>): string {
  const responseIdCamel = typeof value.responseId === "string" ? value.responseId.trim() : ""
  if (responseIdCamel) {
    return responseIdCamel
  }

  const responseIdSnake = typeof value.response_id === "string" ? value.response_id.trim() : ""
  if (responseIdSnake) {
    return responseIdSnake
  }

  if (typeof value.id === "string" && value.id.trim() && value.id.trim().startsWith("resp")) {
    return value.id.trim()
  }

  return ""
}

function isInternalRelayRecord(value: Record<string, unknown>): boolean {
  const hasRoutingKey =
    typeof value.to === "string" ||
    typeof value.from === "string" ||
    typeof value.sender === "string" ||
    typeof value.receiver === "string" ||
    typeof value.recipient === "string" ||
    typeof value.rolloutId === "string" ||
    typeof value.rollout_id === "string"
  if (!hasRoutingKey) {
    return false
  }
  return typeof value.message === "string" || typeof value.content === "string"
}

function isInternalGatewayJsonToken(value: string): boolean {
  const trimmed = value.trim()
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return false
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) {
      return false
    }
    if (isInternalRelayRecord(parsed)) {
      return true
    }

    const toolSignalKeys = [
      "query",
      "q",
      "num_results",
      "number_of_images",
      "image_description",
      "instructions",
      "toolUsageCardId",
    ]
    return toolSignalKeys.some((key) => key in parsed)
  } catch {
    return false
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

function readWebSearchResultsCount(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return value.length
  }
  if (isRecord(value) && Array.isArray(value.results)) {
    return value.results.length
  }
  return undefined
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
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return []
  }

  for (const candidate of candidates) {
    const eventType = typeof candidate.type === "string" ? candidate.type.trim() : ""
    if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
      const row = extractWebSearchToolMetaFromOutputItem(candidate.item)
      if (row) {
        return [row]
      }
    }

    if (eventType === "response.completed") {
      const nested = extractWebSearchToolMetaFromResponse(candidate.response)
      if (nested.length > 0) {
        return nested
      }
    }

    const nestedResponse = extractWebSearchToolMetaFromResponse(candidate.response)
    if (nestedResponse.length > 0) {
      return nestedResponse
    }

    const usage = readToolUsageCard(candidate.toolUsageCard)
    if (!usage || usage.toolName.toLowerCase() !== "websearch" && usage.toolName.toLowerCase() !== "web_search") {
      continue
    }
    const queryRaw = usage.args.query ?? usage.args.q
    const query = typeof queryRaw === "string" ? queryRaw.trim() : ""
    const numResults =
      toPositiveInteger(usage.args.num_results) ??
      toPositiveInteger(usage.args.result_count) ??
      toPositiveInteger(usage.args.max_results)
    if (!query || !numResults) {
      continue
    }
    return [{ query, numResults }]
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
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    const uiLayout = isRecord(candidate.uiLayout) ? candidate.uiLayout : null
    if (!uiLayout) {
      continue
    }

    const responseId = extractResponseIdFromRecord(candidate)
    return {
      layout: {
        reasoningUiLayout: typeof uiLayout.reasoningUiLayout === "string" ? uiLayout.reasoningUiLayout : undefined,
        willThinkLong: typeof uiLayout.willThinkLong === "boolean" ? uiLayout.willThinkLong : undefined,
        effort: typeof uiLayout.effort === "string" ? uiLayout.effort : undefined,
        rolloutIds: readStringArray(uiLayout.rolloutIds),
      },
      isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
      responseId: responseId || undefined,
    }
  }

  return null
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
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (
      candidate.type === "response.output_item.added" &&
      isRecord(candidate.item) &&
      candidate.item.type === "function_call"
    ) {
      const args = parseFunctionArguments(candidate.item.arguments) || {}
      const toolUsageCardId =
        typeof candidate.item.call_id === "string" && candidate.item.call_id.trim()
          ? candidate.item.call_id.trim()
          : typeof candidate.item.id === "string" && candidate.item.id.trim()
            ? candidate.item.id.trim()
            : ""
      if (!toolUsageCardId) {
        continue
      }

      const responseId = extractResponseIdFromRecord(candidate)
      return {
        kind: "tool_usage",
        usage: {
          toolUsageCardId,
          toolName: typeof candidate.item.name === "string" ? candidate.item.name : "tool",
          args,
          rolloutId: typeof candidate.item.rollout_id === "string" ? candidate.item.rollout_id : undefined,
          messageTag: typeof candidate.messageTag === "string" ? candidate.messageTag : undefined,
          isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
          responseId: responseId || undefined,
        },
      }
    }

    const messageTag = typeof candidate.messageTag === "string" ? candidate.messageTag : ""
    const hasToolUsagePayload = isRecord(candidate.toolUsageCard)
    const isToolUsageType = candidate.type === "response.tool_usage_card"
    const isToolUsageMessageTag = messageTag === "tool_usage_card"
    if (!hasToolUsagePayload || (!isToolUsageType && !isToolUsageMessageTag)) {
      continue
    }

    const toolUsage = readToolUsageCard(candidate.toolUsageCard)
    if (!toolUsage) {
      continue
    }

    const responseId = extractResponseIdFromRecord(candidate)
    return {
      kind: "tool_usage",
      usage: {
        toolUsageCardId: toolUsage.toolUsageCardId,
        toolName: toolUsage.toolName,
        args: toolUsage.args,
        rolloutId:
          typeof candidate.rolloutId === "string"
            ? candidate.rolloutId
            : typeof candidate.rollout_id === "string"
              ? candidate.rollout_id
              : undefined,
        messageTag: messageTag || undefined,
        isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
        responseId: responseId || undefined,
      },
    }
  }

  return null
}

function readToolResultEvent(rawChunk: unknown): ChatReasoningEventDetail | null {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (
      candidate.type === "response.output_item.done" &&
      isRecord(candidate.item) &&
      candidate.item.type === "function_call"
    ) {
      const toolUsageCardId =
        typeof candidate.item.call_id === "string" && candidate.item.call_id.trim()
          ? candidate.item.call_id.trim()
          : typeof candidate.item.id === "string" && candidate.item.id.trim()
            ? candidate.item.id.trim()
            : undefined
      const responseId = extractResponseIdFromRecord(candidate)
      return {
        kind: "tool_result",
        result: {
          toolUsageCardId,
          rolloutId: typeof candidate.item.rollout_id === "string" ? candidate.item.rollout_id : undefined,
          messageTag: typeof candidate.messageTag === "string" ? candidate.messageTag : undefined,
          isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
          responseId: responseId || undefined,
        },
      }
    }

    if (typeof candidate.messageTag !== "string" || candidate.messageTag !== "raw_function_result") {
      continue
    }

    const webSearchResultsCount = readWebSearchResultsCount(candidate.webSearchResults)
    if (typeof webSearchResultsCount !== "number") {
      continue
    }
    const responseId = extractResponseIdFromRecord(candidate)
    return {
      kind: "tool_result",
      result: {
        toolUsageCardId: typeof candidate.toolUsageCardId === "string" ? candidate.toolUsageCardId : undefined,
        rolloutId:
          typeof candidate.rolloutId === "string"
            ? candidate.rolloutId
            : typeof candidate.rollout_id === "string"
              ? candidate.rollout_id
              : undefined,
        messageTag: candidate.messageTag,
        webSearchResultsCount,
        isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
        responseId: responseId || undefined,
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

function parseCardAttachmentRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value) && typeof value.jsonData === "string") {
    return parseRecords(value.jsonData)[0] ?? null
  }
  return parseRecords(value)[0] ?? null
}

function readCardAttachmentPayload(value: unknown): ChatCardAttachmentPayload | null {
  const parsed = parseCardAttachmentRecord(value)
  if (!parsed) {
    return null
  }

  const image = isRecord(parsed.image) ? parsed.image : null
  const directUrl = typeof parsed.url === "string" ? parsed.url.trim() : ""
  const imageOriginal = image && typeof image.original === "string" ? image.original.trim() : ""
  const imageThumbnail = image && typeof image.thumbnail === "string" ? image.thumbnail.trim() : ""
  const stableUrl = imageOriginal || directUrl || imageThumbnail
  const idRaw = typeof parsed.id === "string" ? parsed.id.trim() : ""
  const id = idRaw || (stableUrl ? `image_card_${encodeURIComponent(stableUrl)}` : "")
  if (!id) {
    return null
  }

  return {
    id,
    cardType: typeof parsed.cardType === "string" ? parsed.cardType : undefined,
    type: typeof parsed.type === "string" ? parsed.type : undefined,
    url: directUrl || undefined,
    image: image
      ? {
          thumbnail: typeof image.thumbnail === "string" ? image.thumbnail : undefined,
          original: typeof image.original === "string" ? image.original : undefined,
          title: typeof image.title === "string" ? image.title : undefined,
          link: typeof image.link === "string" ? image.link : undefined,
          source: typeof image.source === "string" ? image.source : undefined,
        }
      : undefined,
  }
}

function collectCardAttachmentsFromUnknownList(value: unknown): ChatCardAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []
  for (const item of value) {
    const card = readCardAttachmentPayload(item)
    if (card) {
      cards.push(card)
    }
  }
  return cards
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

  const inlineCard = readCardAttachmentPayload(value.cardAttachment)
  if (inlineCard) {
    cards.push(inlineCard)
  }

  const inlineCardParsed = readCardAttachmentPayload(value.cardAttachmentParsed)
  if (inlineCardParsed) {
    cards.push(inlineCardParsed)
  }

  for (const card of collectCardAttachmentsFromUnknownList(value.cardAttachmentsJson)) {
    cards.push(card)
  }

  for (const card of collectCardAttachmentsFromUnknownList(value.cardAttachments)) {
    cards.push(card)
  }

  return cards
}

export function extractCardAttachmentsFromRawChunk(rawChunk: unknown): ChatCardAttachmentPayload[] {
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return []
  }

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
  const candidates = collectRawChunkCandidates(rawChunk)
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
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (candidate.type === "response.output_text.delta" && typeof candidate.delta === "string") {
      return candidate.delta
    }

    if (typeof candidate.delta === "string") {
      return candidate.delta
    }

    if (typeof candidate.token !== "string") {
      continue
    }

    const messageTag = typeof candidate.messageTag === "string" ? candidate.messageTag.trim().toLowerCase() : ""
    if (messageTag === "header" || messageTag === "tool_usage_card" || messageTag === "raw_function_result") {
      continue
    }
    if (typeof candidate.isThinking === "boolean" && candidate.isThinking && messageTag !== "final") {
      continue
    }
    if (isInternalGatewayJsonToken(candidate.token)) {
      continue
    }
    return candidate.token
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
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (candidate.type === "response.output_text.done" && typeof candidate.text === "string") {
      return candidate.text
    }

    if (candidate.type === "response.completed") {
      const completedText = extractTextFromOutputMessage(candidate.response)
      if (completedText) {
        return completedText
      }
    }

    const outputText = extractTextFromOutputMessage(candidate)
    if (outputText) {
      return outputText
    }

    if (
      typeof candidate.message === "string" &&
      candidate.message.trim() &&
      !(typeof candidate.sender === "string" && candidate.sender.toLowerCase() === "human") &&
      !isInternalGatewayJsonToken(candidate.message)
    ) {
      return candidate.message
    }
  }

  return ""
}

export function extractGatewayResponseIdFromRawChunk(rawChunk: unknown): string {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    const responseId = extractResponseIdFromRecord(candidate)
    if (responseId) {
      return responseId
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
