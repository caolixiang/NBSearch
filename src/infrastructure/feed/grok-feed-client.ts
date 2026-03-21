import type { AppConfig } from "@/app/contracts"
import { getFeedSourceConfig } from "@/domain/feed/source-config"
import type { FeedSource } from "@/domain/feed/types"
import { extractGatewayFinalMessageFromRawChunk } from "@/infrastructure/chat/chunk-parsers-response"
import { normalizeGatewayResponsesUrl } from "@/infrastructure/chat/gateway-url"
import { createRuntimeFetch } from "@/infrastructure/http/runtime-fetch"

const FEED_FETCH_MODEL = "grok-4.1-fast"
const FEED_FETCH_TIMEOUT_MS = 60_000
const FEED_LATEST_POST_LIMIT = 5
const FEED_EXTRA_MEDIA_POST_LIMIT = 3

type FeedGatewayPost = {
  id: string
  timestamp: string
  content: string
  has_media: boolean
  media_urls?: string[]
}

type FeedGatewayPayload = {
  account: string
  latest_posts: FeedGatewayPost[]
  extra_with_media?: FeedGatewayPost[]
  note?: string
}

export interface FeedFetchPost {
  postId: string
  content: string
  mediaUrls: string[]
  canonicalUrl: string
  publishedAt: number | null
}

export interface FeedFetchClient {
  fetchPosts(source: FeedSource, signal?: AbortSignal): Promise<FeedFetchPost[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizePostId(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizePostText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""
}

function normalizeMediaUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
    )
  )
}

function normalizePublishedAt(value: unknown): number | null {
  if (typeof value !== "string") {
    return null
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function extractJsonObjectText(raw: string): string {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fencedMatch?.[1]?.trim() || raw.trim()
  if (!text) {
    return ""
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    return text
  }

  const startIndex = text.indexOf("{")
  if (startIndex < 0) {
    return ""
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "\"") {
      inString = !inString
      continue
    }
    if (inString) {
      continue
    }
    if (char === "{") {
      depth += 1
      continue
    }
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        return text.slice(startIndex, index + 1).trim()
      }
    }
  }

  return ""
}

function normalizeGatewayPayload(raw: unknown, source: FeedSource): FeedFetchPost[] {
  if (!isRecord(raw)) {
    throw new Error(`${getFeedSourceConfig(source).label} 返回了无效 JSON 对象`)
  }
  const sourceConfig = getFeedSourceConfig(source)
  const accountValue = typeof raw.account === "string" ? raw.account.trim().toLowerCase() : ""
  if (!accountValue) {
    throw new Error(`${sourceConfig.label} 缺少 account 字段`)
  }
  const expectedAccounts = new Set([
    sourceConfig.accountTag.toLowerCase(),
    sourceConfig.accountHandle.toLowerCase(),
  ])
  if (accountValue && !expectedAccounts.has(accountValue)) {
    throw new Error(`${sourceConfig.label} 返回了错误账号：${raw.account}`)
  }

  const latest = Array.isArray(raw.latest_posts) ? raw.latest_posts : []
  const extra = Array.isArray(raw.extra_with_media) ? raw.extra_with_media : []
  const profileUrl = sourceConfig.profileUrl
  const seenIds = new Set<string>()
  const combined = latest
    .slice(0, FEED_LATEST_POST_LIMIT)
    .concat(extra.slice(0, FEED_EXTRA_MEDIA_POST_LIMIT))

  const posts = combined
    .map((item) => {
      if (!isRecord(item)) {
        return null
      }
      const postId = normalizePostId(item.id)
      const content = normalizePostText(item.content)
      const mediaUrls = normalizeMediaUrls(item.media_urls)
      const publishedAt = normalizePublishedAt(item.timestamp)
      if (!postId || seenIds.has(postId)) {
        return null
      }
      if (!content && mediaUrls.length === 0) {
        return null
      }
      seenIds.add(postId)
      return {
        postId,
        content,
        mediaUrls,
        canonicalUrl: `${profileUrl}/status/${postId}`,
        publishedAt,
      } satisfies FeedFetchPost
    })
    .filter((item): item is FeedFetchPost => item !== null)

  if (posts.length === 0) {
    throw new Error(`${sourceConfig.label} 未返回可用帖子`)
  }

  return posts
}

function extractGatewayOutputText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ""
  }
  try {
    const parsed = JSON.parse(trimmed)
    return extractGatewayFinalMessageFromRawChunk(parsed) || trimmed
  } catch {
    return trimmed
  }
}

export function buildFeedFetchPrompt(source: FeedSource): string {
  const config = getFeedSourceConfig(source)
  return [
    `查询 ${config.profileUrl} 的最新公开 X 帖子，并只输出一个合法 JSON 对象。`,
    "不要输出 Markdown 代码块，不要输出解释文字，不要在 JSON 前后补充任何说明。",
    `account 必须精确写成 "${config.accountTag}"。`,
    `latest_posts 必须包含最新 ${FEED_LATEST_POST_LIMIT} 条主帖，按时间从新到旧排序，忽略置顶和重复项。`,
    `extra_with_media 最多返回 ${FEED_EXTRA_MEDIA_POST_LIMIT} 条不在 latest_posts 里的较新旧帖，但必须带媒体。`,
    "每条帖子都必须包含：id、timestamp、content、engagement、has_media；如果有媒体，再补 media_urls。",
    "timestamp 使用 ISO 8601 UTC 格式，例如 2026-03-20T13:52:39Z。",
    "content 必须保留原帖原文与换行，不要翻译，不要总结，不要改写。",
    "engagement 必须是对象，包含整数 likes、reposts、quotes、replies、views；未知时填 0。",
    "has_media 为 true 时，media_urls 必须提供直接图片/视频 URL，例如 pbs.twimg.com 或 video.twimg.com 链接。",
    "如果最新 5 条没有图片，可以在 extra_with_media 里补几条较新的带图/带视频帖子。",
    '输出 schema: {"account":"@Account","latest_posts":[{"id":"203...","timestamp":"2026-03-20T13:52:39Z","content":"Original post text","engagement":{"likes":0,"reposts":0,"quotes":0,"replies":0,"views":0},"has_media":false}],"extra_with_media":[{"id":"203...","timestamp":"2026-03-20T13:52:39Z","content":"Original post text","engagement":{"likes":0,"reposts":0,"quotes":0,"replies":0,"views":0},"has_media":true,"media_urls":["https://pbs.twimg.com/media/example.jpg"]}],"note":"简短中文备注"}',
  ].join("\n")
}

export function parseFeedGatewayPosts(raw: string, source: FeedSource): FeedFetchPost[] {
  const outputText = extractGatewayOutputText(raw)
  const jsonText = extractJsonObjectText(outputText)
  if (!jsonText) {
    throw new Error(`${getFeedSourceConfig(source).label} 未返回合法 JSON`)
  }
  let parsed: FeedGatewayPayload
  try {
    parsed = JSON.parse(jsonText) as FeedGatewayPayload
  } catch {
    throw new Error(`${getFeedSourceConfig(source).label} JSON 解析失败`)
  }
  return normalizeGatewayPayload(parsed, source)
}

export class RuntimeGrokFeedClient implements FeedFetchClient {
  private readonly apiUrl: string
  private readonly runtimeFetch: typeof fetch

  constructor(private readonly config: AppConfig) {
    this.apiUrl = normalizeGatewayResponsesUrl(config.apiBaseUrl)
    this.runtimeFetch = createRuntimeFetch(fetch)
  }

  async fetchPosts(source: FeedSource, signal?: AbortSignal): Promise<FeedFetchPost[]> {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener("abort", forwardAbort, { once: true })

    try {
      const response = await this.runtimeFetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: FEED_FETCH_MODEL,
          stream: false,
          instructions: "You extract recent X posts into valid JSON and must return JSON only.",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildFeedFetchPrompt(source),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      })

      const rawText = await response.text()
      if (!response.ok) {
        throw new Error(rawText || `${getFeedSourceConfig(source).label} 拉取失败`)
      }
      return parseFeedGatewayPosts(rawText, source)
    } finally {
      globalThis.clearTimeout(timeout)
      signal?.removeEventListener("abort", forwardAbort)
    }
  }
}
