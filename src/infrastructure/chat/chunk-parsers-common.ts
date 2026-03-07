import type {
  ChatAnchors,
  ChatCardAttachmentPayload,
  ChatMessage,
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

export function parseRecords(value: unknown): Record<string, unknown>[] {
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

export function collectRawChunkCandidates(rawChunk: unknown): Record<string, unknown>[] {
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
      append(parsed.result.conversation)
      append(parsed.result.modelResponse)
      if (isRecord(parsed.result.response)) {
        append(parsed.result.response.modelResponse)
      }
    }
  }

  return candidates
}

export function normalizeResponseIdCandidate(input: unknown): string {
  if (typeof input !== "string") {
    return ""
  }
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed
  }
  if (/^resp[_-]/i.test(trimmed)) {
    return trimmed
  }
  return ""
}

export function readExplicitResponseId(value: Record<string, unknown>): string {
  const direct =
    normalizeResponseIdCandidate(value.responseId) || normalizeResponseIdCandidate(value.response_id)
  if (direct) {
    return direct
  }

  if (isRecord(value.modelResponse)) {
    const nested = readExplicitResponseId(value.modelResponse)
    if (nested) {
      return nested
    }
  }

  return ""
}

export function extractResponseIdFromRecord(value: Record<string, unknown>): string {
  const direct = readExplicitResponseId(value)
  if (direct) {
    return direct
  }

  if (isRecord(value.response)) {
    const nestedResponseId = readExplicitResponseId(value.response)
    if (nestedResponseId) {
      return nestedResponseId
    }
  }

  if (isRecord(value.metadata)) {
    const metadataResponseId = readExplicitResponseId(value.metadata)
    if (metadataResponseId) {
      return metadataResponseId
    }
  }

  return ""
}

export function readAssistantResponseIdFromGatewayResponse(value: Record<string, unknown>): string {
  if (isRecord(value.modelResponse)) {
    const modelResponseId = readExplicitResponseId(value.modelResponse)
    if (modelResponseId) {
      return modelResponseId
    }
  }

  if (isRecord(value.userResponse)) {
    return ""
  }

  return readExplicitResponseId(value)
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

export function isInternalGatewayJsonToken(value: string): boolean {
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

export function parseFunctionArguments(value: unknown): Record<string, unknown> | null {
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

export function readWebSearchResultsCount(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return value.length
  }
  if (isRecord(value)) {
    if (Array.isArray(value.results)) {
      return value.results.length
    }
    if (isRecord(value.xSearchResults) && Array.isArray(value.xSearchResults.results)) {
      return value.xSearchResults.results.length
    }
  }
  return undefined
}

function buildXPostUrl(authorHandle: string | undefined, postId: string | undefined): string | undefined {
  const handle = (authorHandle || "").trim()
  const id = (postId || "").trim()
  if (!handle || !id) {
    return undefined
  }
  return `https://x.com/${handle}/status/${id}`
}

export function readWebSearchResults(value: unknown): WebSearchResultItem[] | undefined {
  let list: unknown[] | undefined
  if (Array.isArray(value)) {
    list = value
  } else if (isRecord(value) && Array.isArray(value.results)) {
    list = value.results
  } else if (isRecord(value) && isRecord(value.xSearchResults) && Array.isArray(value.xSearchResults.results)) {
    list = value.xSearchResults.results
  }

  if (!list) {
    return undefined
  }

  const results: WebSearchResultItem[] = []
  for (const item of list) {
    if (isRecord(item)) {
      const authorName = typeof item.name === "string" ? item.name.trim() || undefined : undefined
      const authorHandle = typeof item.username === "string" ? item.username.trim() || undefined : undefined
      const publishedAt = typeof item.createTime === "string" ? item.createTime.trim() || undefined : undefined
      const postId = typeof item.postId === "string" ? item.postId.trim() || undefined : undefined
      const isXPost = Boolean(authorName || authorHandle || publishedAt || postId)
      const title =
        typeof item.title === "string"
          ? item.title
          : [authorName || "", authorHandle ? `@${authorHandle}` : ""].join(" ").trim() || undefined
      const url =
        typeof item.url === "string"
          ? item.url
          : typeof item.link === "string"
            ? item.link
            : buildXPostUrl(authorHandle, postId)
      const preview =
        typeof item.preview === "string"
          ? item.preview
          : typeof item.snippet === "string"
            ? item.snippet
            : typeof item.text === "string"
              ? item.text
              : typeof item.textMarkdown === "string"
                ? item.textMarkdown
                : undefined
      if (!title && !url && !preview) {
        continue
      }
      results.push({
        ...(isXPost ? { kind: "x_post" as const } : {}),
        title,
        url,
        preview,
        favicon: typeof item.favicon === "string" ? item.favicon : undefined,
        ...(authorName ? { authorName } : {}),
        ...(authorHandle ? { authorHandle } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(postId ? { postId } : {}),
      })
    }
  }
  return results.length > 0 ? results : undefined
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

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

export function readStringOrStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (!Array.isArray(value)) {
    return []
  }
  const rows: string[] = []
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim()
      if (trimmed) {
        rows.push(trimmed)
      }
    }
  }
  return rows
}

export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.trim()
  return normalized ? normalized : undefined
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
