import { generateText } from "ai"
import { z } from "zod"
import type { AppConfig } from "@/app/contracts"
import { appendClientLog, logClientError } from "@/app/client-log"
import type { FeedItemTranslationStatus } from "@/domain/feed/types"
import {
  createOpenAICompatibleProvider,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
} from "@/infrastructure/llm/openai-compatible-client"
const FEED_TRANSLATOR_SCOPE = "feed-openai-translator"

const TRANSLATION_RESPONSE_SCHEMA = z.array(
  z.object({
    contentHash: z.string().trim().min(1),
    titleZh: z.string(),
    contentMarkdownZh: z.string(),
  })
)

export interface FeedTranslationRequest {
  contentHash: string
  title: string
  contentMarkdown: string
}

export interface FeedTranslationResult {
  contentHash: string
  titleZh: string
  contentMarkdownZh: string
  status: FeedItemTranslationStatus
  model: string
  translatedAt: number | null
}

export interface FeedTranslator {
  translateMany(items: FeedTranslationRequest[]): Promise<FeedTranslationResult[]>
}

function buildSkippedResults(items: FeedTranslationRequest[]): FeedTranslationResult[] {
  return items.map((item) => ({
    contentHash: item.contentHash,
    titleZh: "",
    contentMarkdownZh: "",
    status: "skipped",
    model: "",
    translatedAt: null,
  }))
}

function buildFailedResults(items: FeedTranslationRequest[], model: string): FeedTranslationResult[] {
  return items.map((item) => ({
    contentHash: item.contentHash,
    titleZh: "",
    contentMarkdownZh: "",
    status: "failed",
    model,
    translatedAt: null,
  }))
}

function stripMarkdownCodeFence(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function extractJsonArray(input: string): string {
  const normalized = stripMarkdownCodeFence(input)
  const start = normalized.indexOf("[")
  const end = normalized.lastIndexOf("]")
  if (start >= 0 && end > start) {
    return normalized.slice(start, end + 1)
  }
  return normalized
}

function normalizeTranslatedText(input: string): string {
  return input.replace(/\r\n/g, "\n").trim()
}

export class OpenAIFeedTranslator implements FeedTranslator {
  constructor(private readonly config: AppConfig) {}

  async translateMany(items: FeedTranslationRequest[]): Promise<FeedTranslationResult[]> {
    if (items.length === 0) {
      return []
    }

    const apiKey = this.config.openaiApiKey.trim()
    const baseURL = this.config.openaiApiBaseUrl.trim()
    const model = this.config.openaiTranslationModel.trim() || DEFAULT_OPENAI_COMPATIBLE_MODEL
    if (!apiKey || !baseURL) {
      return buildSkippedResults(items)
    }

    const provider = createOpenAICompatibleProvider({
      baseUrl: baseURL,
      apiKey,
    })

    try {
      const { text } = await generateText({
        model: provider.chat(model),
        maxOutputTokens: Math.max(800, items.length * 320),
        system: [
          "You translate social/news feed posts into Simplified Chinese for local storage.",
          "Return only a JSON array.",
          "Do not add commentary, analysis, markdown code fences, or extra fields.",
          "Preserve facts, names, numbers, percentages, dates, tickers, hashtags, URLs, emojis, and line breaks.",
          "If the source text is already Chinese, keep its meaning and wording natural in Simplified Chinese.",
          "Keep markdown structure usable in the translated content.",
        ].join(" "),
        prompt: [
          "Translate each item into Simplified Chinese.",
          "Keep the same contentHash in the output so the caller can match records.",
          'Output schema: [{"contentHash":"...","titleZh":"...","contentMarkdownZh":"..."}].',
          "",
          JSON.stringify(items),
        ].join("\n"),
      })

      const parsed = TRANSLATION_RESPONSE_SCHEMA.parse(JSON.parse(extractJsonArray(text)))
      const translatedAt = Date.now()
      const translatedByHash = new Map(parsed.map((item) => [item.contentHash, item]))

      const results = items.map<FeedTranslationResult>((item) => {
        const translated = translatedByHash.get(item.contentHash)
        if (!translated) {
          return {
            contentHash: item.contentHash,
            titleZh: "",
            contentMarkdownZh: "",
            status: "failed",
            model,
            translatedAt: null,
          }
        }
        return {
          contentHash: item.contentHash,
          titleZh: normalizeTranslatedText(translated.titleZh),
          contentMarkdownZh: normalizeTranslatedText(translated.contentMarkdownZh),
          status: "translated",
          model,
          translatedAt,
        }
      })

      const failedCount = results.filter((item) => item.status !== "translated").length
      if (failedCount > 0) {
        await appendClientLog({
          level: "warn",
          scope: FEED_TRANSLATOR_SCOPE,
          message: "translation_batch_partial_miss",
          context: {
            requestedCount: items.length,
            resolvedCount: parsed.length,
            failedCount,
            model,
          },
        })
      }

      return results
    } catch (error) {
      await logClientError(FEED_TRANSLATOR_SCOPE, error, {
        itemCount: items.length,
        model,
        baseURL,
      })
      return buildFailedResults(items, model)
    }
  }
}
