import type {
  ChatCardAttachmentPayload,
  ChatAnchors,
  ChatMessage,
  ChatReasoningEventDetail,
  ChatReasoningLayout,
  ChatStreamEvent,
  SendChatTurnInput,
  WebSearchResultItem,
} from "../../domain/chat/types"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJsonObjectStrings(raw: string): string[] {
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

// ---------------------------------------------------------------------------
// Web search tool meta
// ---------------------------------------------------------------------------

export type WebSearchToolMeta = {
  query: string
  numResults: number
}

export type AssistantToolMetaPayload = {
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

function readWebSearchResults(value: unknown): WebSearchResultItem[] | undefined {
  let list: unknown[] | undefined;
  if (Array.isArray(value)) {
    list = value;
  } else if (isRecord(value) && Array.isArray(value.results)) {
    list = value.results;
  }

  if (!list) return undefined;

  const results: WebSearchResultItem[] = [];
  for (const item of list) {
    if (isRecord(item)) {
      results.push({
        title: typeof item.title === "string" ? item.title : undefined,
        url: typeof item.url === "string" ? item.url : typeof item.link === "string" ? item.link : undefined,
        preview: typeof item.preview === "string" ? item.preview : typeof item.snippet === "string" ? item.snippet : undefined,
        favicon: typeof item.favicon === "string" ? item.favicon : undefined,
      });
    }
  }
  return results.length > 0 ? results : undefined;
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

// ---------------------------------------------------------------------------
// Reasoning layout / tool usage / tool result
// ---------------------------------------------------------------------------

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
    const webSearchResults = readWebSearchResults(candidate.webSearchResults)
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
        webSearchResults,
        isThinking: typeof candidate.isThinking === "boolean" ? candidate.isThinking : undefined,
        responseId: responseId || undefined,
      },
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Card attachments
// ---------------------------------------------------------------------------

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function readOptionalExpiresAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000
    const iso = new Date(millis).toISOString()
    return iso === "Invalid Date" ? undefined : iso
  }
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number.parseFloat(trimmed)
    if (!Number.isFinite(parsed)) {
      return undefined
    }
    const millis = parsed > 1_000_000_000_000 ? parsed : parsed * 1000
    const iso = new Date(millis).toISOString()
    return iso === "Invalid Date" ? undefined : iso
  }
  const millis = Date.parse(trimmed)
  if (!Number.isFinite(millis)) {
    return undefined
  }
  return new Date(millis).toISOString()
}

function isLocalGeneratedImageAssetId(value: string): boolean {
  return /^image_[0-9a-f]{64}$/i.test(value.trim())
}

function readGeneratedImageUpstreamAssetId(value: Record<string, unknown>): string | undefined {
  return readOptionalString(value.assetId) || readOptionalString(value.imageId) || readOptionalString(value.image_id)
}

function readGeneratedImageLocalAssetId(value: Record<string, unknown>): string | undefined {
  const candidates = [
    readOptionalString(value.asset_id),
    readOptionalString(value.assetId),
    readOptionalString(value.imageId),
    readOptionalString(value.image_id),
  ]
  for (const candidate of candidates) {
    const normalized = (candidate || "").trim()
    if (isLocalGeneratedImageAssetId(normalized)) {
      return normalized
    }
  }
  return undefined
}

function readGeneratedImageModeratedFlag(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return value.moderated === true || value.rRated === true || value.r_rated === true
}

type GeneratedImageAttachment = {
  url: string
  assetId?: string
  asset_id?: string
  rawUrl?: string
  urlExpiresAt?: string
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim())
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function isIntermediateGeneratedImageUrl(url: string): boolean {
  return /-part-\d+(?=\/|$)/i.test(url)
}

function readGeneratedImageAttachment(value: unknown): GeneratedImageAttachment | null {
  if (typeof value === "string") {
    const url = value.trim()
    if (!url || isIntermediateGeneratedImageUrl(url)) {
      return null
    }
    return { url }
  }
  if (!isRecord(value)) {
    return null
  }
  const url = readOptionalString(value.url) || readOptionalString(value.imageUrl) || readOptionalString(value.image_url)
  if (!url) {
    return null
  }
  const assetId = readGeneratedImageUpstreamAssetId(value)
  const asset_id = readGeneratedImageLocalAssetId(value)
  const moderated = value.moderated === true
  const rrated = value.rRated === true || value.r_rated === true
  if (moderated || rrated) {
    return null
  }

  const progress = toOptionalNumber(value.progress)
  const isStreamingImageGeneration =
    "streamingImageGenerationResponse" in value ||
    "imageId" in value ||
    "image_id" in value ||
    "imageIndex" in value ||
    "image_index" in value ||
    "progress" in value ||
    "seq" in value

  // Match Grok behavior: ignore intermediate "-part-*" images and keep only final outputs.
  if (isIntermediateGeneratedImageUrl(url)) {
    return null
  }
  if (isStreamingImageGeneration && typeof progress === "number" && progress < 100) {
    return null
  }

  return {
    url,
    assetId,
    asset_id,
    rawUrl: readOptionalString(value.rawUrl) || readOptionalString(value.raw_url),
    urlExpiresAt: readOptionalExpiresAt(value.urlExpiresAt) || readOptionalExpiresAt(value.url_expires_at),
  }
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: string[] = []
  for (const item of value) {
    const normalized = readOptionalString(item)
    if (normalized) {
      rows.push(normalized)
    } else {
      rows.push("")
    }
  }
  return rows
}

function readExpiresList(value: unknown): Array<string | undefined> {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: Array<string | undefined> = []
  for (const item of value) {
    rows.push(readOptionalExpiresAt(item))
  }
  return rows
}

function collectGeneratedImageAttachmentsFromIndexedArrays(value: Record<string, unknown>): GeneratedImageAttachment[] {
  const urls = readStringList(value.generatedImageUrls)
  if (urls.length === 0) {
    return []
  }
  const rawUrlsPrimary = readStringList(value.generatedImageRawUrls)
  const rawUrlsFallback = readStringList(value.generatedImageRawURLs)
  const rawUrls = rawUrlsPrimary.length > 0 ? rawUrlsPrimary : rawUrlsFallback
  const assetIdsPrimary = readStringList(value.generatedImageAssetIds)
  const assetIdsFallback = readStringList(value.generatedImageAssetIDs)
  const assetIds = assetIdsPrimary.length > 0 ? assetIdsPrimary : assetIdsFallback
  const expiresAtPrimary = readExpiresList(value.generatedImageURLExpiresAt)
  const expiresAtFallback = readExpiresList(value.generatedImageUrlExpiresAt)
  const expiresAt = expiresAtPrimary.length > 0 ? expiresAtPrimary : expiresAtFallback

  const items: GeneratedImageAttachment[] = []
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]?.trim() || ""
    if (!url || isIntermediateGeneratedImageUrl(url)) {
      continue
    }
    items.push({
      url,
      rawUrl: rawUrls[index]?.trim() || undefined,
      asset_id: assetIds[index]?.trim() || undefined,
      urlExpiresAt: expiresAt[index],
    })
  }
  return items
}

function generatedImageAttachmentScore(item: GeneratedImageAttachment): number {
  let score = 0
  if (item.asset_id) {
    score += 2
  }
  if (item.assetId) {
    score += 1
  }
  if (item.rawUrl) {
    score += 1
  }
  if (item.urlExpiresAt) {
    score += 1
  }
  return score
}

function buildGeneratedImageCard(payload: GeneratedImageAttachment): ChatCardAttachmentPayload {
  const { url, assetId, asset_id, rawUrl, urlExpiresAt } = payload
  const stableId = `generated_image_${encodeURIComponent(url)}`
  return {
    id: stableId,
    cardType: "image_card",
    type: "generated_image",
    url,
    assetId,
    asset_id,
    rawUrl,
    urlExpiresAt,
    image: {
      original: url,
    },
  }
}

function collectGeneratedImageAttachmentsFromEnvelope(value: Record<string, unknown>): GeneratedImageAttachment[] {
  const byUrl = new Map<string, GeneratedImageAttachment>()
  const append = (item: GeneratedImageAttachment | null) => {
    if (!item) {
      return
    }
    const key = item.url.trim()
    if (!key) {
      return
    }
    const existing = byUrl.get(key)
    if (!existing) {
      byUrl.set(key, item)
      return
    }
    if (generatedImageAttachmentScore(item) > generatedImageAttachmentScore(existing)) {
      byUrl.set(key, item)
    }
  }

  const streamingImageGeneration = isRecord(value.streamingImageGenerationResponse)
    ? value.streamingImageGenerationResponse
    : null
  if (streamingImageGeneration) {
    append(readGeneratedImageAttachment(streamingImageGeneration))
  }

  if (Array.isArray(value.generatedImageUrls)) {
    for (const item of value.generatedImageUrls) {
      append(readGeneratedImageAttachment(item))
    }
  }
  for (const item of collectGeneratedImageAttachmentsFromIndexedArrays(value)) {
    append(item)
  }

  const modelResponse = isRecord(value.modelResponse) ? value.modelResponse : null
  if (modelResponse && Array.isArray(modelResponse.generatedImageUrls)) {
    for (const item of modelResponse.generatedImageUrls) {
      append(readGeneratedImageAttachment(item))
    }
  }
  if (modelResponse) {
    for (const item of collectGeneratedImageAttachmentsFromIndexedArrays(modelResponse)) {
      append(item)
    }
  }

  return Array.from(byUrl.values())
}

export function extractGeneratedImageModeratedFromRawChunk(rawChunk: unknown): boolean {
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return false
  }

  for (const candidate of candidates) {
    if (readGeneratedImageModeratedFlag(candidate)) {
      return true
    }

    const streamingImageGeneration = isRecord(candidate.streamingImageGenerationResponse)
      ? candidate.streamingImageGenerationResponse
      : null
    if (streamingImageGeneration && readGeneratedImageModeratedFlag(streamingImageGeneration)) {
      return true
    }

    const arraysToCheck: unknown[][] = []
    if (Array.isArray(candidate.generatedImageUrls)) {
      arraysToCheck.push(candidate.generatedImageUrls)
    }
    if (Array.isArray(candidate.data)) {
      arraysToCheck.push(candidate.data)
    }
    if (isRecord(candidate.image_generation) && Array.isArray(candidate.image_generation.data)) {
      arraysToCheck.push(candidate.image_generation.data)
    }
    if (isRecord(candidate.modelResponse) && Array.isArray(candidate.modelResponse.generatedImageUrls)) {
      arraysToCheck.push(candidate.modelResponse.generatedImageUrls)
    }
    for (const list of arraysToCheck) {
      for (const item of list) {
        if (readGeneratedImageModeratedFlag(item)) {
          return true
        }
      }
    }
  }

  return false
}

function parseCardAttachmentRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value) && typeof value.jsonData === "string") {
    return parseRecords(value.jsonData)[0] ?? null
  }
  return parseRecords(value)[0] ?? null
}

type CardAttachmentParseOptions = {
  dropGeneratedImageCard?: boolean
}

function readCardAttachmentPayload(
  value: unknown,
  options: CardAttachmentParseOptions = {}
): ChatCardAttachmentPayload | null {
  const parsed = parseCardAttachmentRecord(value)
  if (!parsed) {
    return null
  }

  const image = isRecord(parsed.image) ? parsed.image : null
  const directUrl = typeof parsed.url === "string" ? parsed.url.trim() : ""
  const imageOriginal = image && typeof image.original === "string" ? image.original.trim() : ""
  const imageThumbnail = image && typeof image.thumbnail === "string" ? image.thumbnail.trim() : ""
  const stableUrl = imageOriginal || directUrl || imageThumbnail
  const normalizedType = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : ""
  const isGeneratedImageCard =
    normalizedType === "generated_image" ||
    normalizedType.includes("generated_image") ||
    /(?:^|\/)generated\//i.test(stableUrl) ||
    /\/assets\/image\//i.test(stableUrl)
  if (isGeneratedImageCard && options.dropGeneratedImageCard) {
    return null
  }
  if (isGeneratedImageCard) {
    if (isIntermediateGeneratedImageUrl(stableUrl)) {
      return null
    }
    const progress = toOptionalNumber(parsed.progress) ?? (image ? toOptionalNumber(image.progress) : null)
    if (typeof progress === "number" && progress < 100) {
      return null
    }
    if (readGeneratedImageModeratedFlag(parsed) || (image && readGeneratedImageModeratedFlag(image))) {
      return null
    }
  }
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
    assetId: readGeneratedImageUpstreamAssetId(parsed),
    asset_id: readGeneratedImageLocalAssetId(parsed),
    rawUrl: readOptionalString(parsed.rawUrl) || readOptionalString(parsed.raw_url),
    urlExpiresAt: readOptionalExpiresAt(parsed.urlExpiresAt) || readOptionalExpiresAt(parsed.url_expires_at),
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

function collectCardAttachmentsFromUnknownList(
  value: unknown,
  options: CardAttachmentParseOptions = {}
): ChatCardAttachmentPayload[] {
  if (!Array.isArray(value)) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []
  for (const item of value) {
    const card = readCardAttachmentPayload(item, options)
    if (card) {
      cards.push(card)
    }
  }
  return cards
}

function collectCardAttachmentsFromEnvelope(
  value: unknown,
  options: CardAttachmentParseOptions = {}
): ChatCardAttachmentPayload[] {
  if (!isRecord(value)) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []

  const imageGeneration = isRecord(value.image_generation) ? value.image_generation : null
  const imageGenerationData = imageGeneration && Array.isArray(imageGeneration.data) ? imageGeneration.data : []
  for (const item of imageGenerationData) {
    const generated = readGeneratedImageAttachment(item)
    if (generated) {
      if (!options.dropGeneratedImageCard) {
        cards.push(buildGeneratedImageCard(generated))
      }
    }
  }

  const responseData = Array.isArray(value.data) ? value.data : []
  for (const item of responseData) {
    const generated = readGeneratedImageAttachment(item)
    if (generated) {
      if (!options.dropGeneratedImageCard) {
        cards.push(buildGeneratedImageCard(generated))
      }
    }
  }

  for (const generated of collectGeneratedImageAttachmentsFromEnvelope(value)) {
    if (!options.dropGeneratedImageCard) {
      cards.push(buildGeneratedImageCard(generated))
    }
  }

  const inlineCard = readCardAttachmentPayload(value.cardAttachment, options)
  if (inlineCard) {
    cards.push(inlineCard)
  }

  const inlineCardParsed = readCardAttachmentPayload(value.cardAttachmentParsed, options)
  if (inlineCardParsed) {
    cards.push(inlineCardParsed)
  }

  for (const card of collectCardAttachmentsFromUnknownList(value.cardAttachmentsJson, options)) {
    cards.push(card)
  }

  for (const card of collectCardAttachmentsFromUnknownList(value.cardAttachments, options)) {
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
    const eventType = typeof candidate.type === "string" ? candidate.type.trim() : ""
    const dropGeneratedImageCard = eventType === "response.output_item.added"
    for (const card of collectCardAttachmentsFromEnvelope(candidate, { dropGeneratedImageCard })) {
      if (seen.has(card.id)) {
        continue
      }
      seen.add(card.id)
      cards.push(card)
    }
  }

  return cards
}

// ---------------------------------------------------------------------------
// Reasoning events (aggregated)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool meta / title
// ---------------------------------------------------------------------------

export function appendToolMeta(content: string, payload: AssistantToolMetaPayload): string {
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

// ---------------------------------------------------------------------------
// Text delta / final message / response id extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Conversation title
// ---------------------------------------------------------------------------

export function resolveConversationTitle(upstreamTitle: string, currentTitle: string): string {
  const upstream = upstreamTitle.trim()
  if (upstream) {
    return upstream
  }
  return currentTitle.trim()
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function buildConversationId(input: Partial<ChatAnchors>): string {
  if (input.conversationId?.trim()) {
    return input.conversationId.trim()
  }
  if (input.sessionId?.trim()) {
    return input.sessionId.trim()
  }
  return `conv_${crypto.randomUUID()}`
}

export function buildUserMessage(text: string): ChatMessage {
  return {
    id: `usr_${crypto.randomUUID()}`,
    role: "user",
    content: text,
    createdAt: Date.now(),
    status: "completed",
  }
}

/**
 * Extract the `isThinking` boolean from a raw Grok chunk.
 * Returns `true`, `false`, or `null` if not present.
 */
export function extractChunkIsThinking(rawChunk: unknown): boolean | null {
  if (!isRecord(rawChunk)) {
    return null
  }
  // Direct: { isThinking: boolean }
  if (typeof rawChunk.isThinking === "boolean") {
    return rawChunk.isThinking
  }
  // Wrapped: { result: { response: { isThinking: boolean } } }
  const result = isRecord(rawChunk.result) ? rawChunk.result : null
  const response = result && isRecord(result.response) ? result.response : null
  if (response && typeof response.isThinking === "boolean") {
    return response.isThinking
  }
  // Direct response: { response: { isThinking: boolean } }
  const directResponse = isRecord(rawChunk.response) ? rawChunk.response : null
  if (directResponse && typeof directResponse.isThinking === "boolean") {
    return directResponse.isThinking
  }
  return null
}
