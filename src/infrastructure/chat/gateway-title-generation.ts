import { generateText } from "ai"
import type { AppConfig } from "@/app/contracts"
import { logClientError } from "@/app/client-log"
import {
  createOpenAICompatibleProvider,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
} from "@/infrastructure/llm/openai-compatible-client"

const CHAT_TITLE_GENERATION_SCOPE = "chat-title-generation"
const MAX_GENERATED_TITLE_CHARS = 24
const FALLBACK_TITLE_CHARS = 10

type TitleGenerationConfig = Pick<
  AppConfig,
  "openaiApiBaseUrl" | "openaiApiKey" | "openaiTranslationModel"
>

function stripMarkdownCodeFence(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/^```(?:text|txt|markdown)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function takeChars(input: string, maxChars: number): string {
  return Array.from(input).slice(0, maxChars).join("").trim()
}

export function shouldGeneratePostCompletionTitleForModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized || normalized.includes("fast")) {
    return false
  }
  if (!normalized.includes("grok")) {
    return false
  }
  return (
    normalized.includes("expert") ||
    normalized.includes("reasoning") ||
    normalized.includes("latest") ||
    normalized.includes("max") ||
    normalized.includes("grok-4.20") ||
    normalized.includes("grok-4-20")
  )
}

export function fallbackConversationTitleFromUserPrompt(prompt: string): string {
  const firstLine =
    prompt
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || ""
  if (!firstLine) {
    return ""
  }
  const firstSentence = firstLine.match(/^[^。！？!?\.]+/)?.[0]?.trim() || firstLine
  return takeChars(firstSentence, FALLBACK_TITLE_CHARS)
}

export function normalizeGeneratedConversationTitle(input: string): string {
  const firstLine =
    stripMarkdownCodeFence(input)
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || ""
  const withoutPrefix = firstLine.replace(/^标题\s*[:：]\s*/i, "").trim()
  const withoutQuotes = withoutPrefix
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .replace(/[。.!！?？]+$/, "")
    .trim()
  return takeChars(withoutQuotes, MAX_GENERATED_TITLE_CHARS)
}

export async function resolvePostCompletionConversationTitle(input: {
  model: string
  prompt: string
  config: TitleGenerationConfig
  fetchFn?: typeof fetch
}): Promise<string> {
  if (!shouldGeneratePostCompletionTitleForModel(input.model)) {
    return ""
  }

  const fallbackTitle = fallbackConversationTitleFromUserPrompt(input.prompt)
  const apiKey = input.config.openaiApiKey.trim()
  const baseUrl = input.config.openaiApiBaseUrl.trim()
  const model = input.config.openaiTranslationModel.trim() || DEFAULT_OPENAI_COMPATIBLE_MODEL
  if (!apiKey || !baseUrl) {
    return fallbackTitle
  }

  try {
    const provider = createOpenAICompatibleProvider({
      baseUrl,
      apiKey,
      fetchFn: input.fetchFn,
    })
    const { text } = await generateText({
      model: provider.chat(model),
      maxOutputTokens: 40,
      system: [
        "你是对话标题生成器。",
        "根据用户第一轮问题生成一个简短的简体中文标题。",
        "只输出标题文本，不要解释，不要引号，不要 Markdown。",
        "标题尽量控制在 10 个中文字符以内。",
      ].join(" "),
      prompt: [
        "用户问题：",
        input.prompt.trim() || "无文本问题",
        "",
        "请生成标题：",
      ].join("\n"),
    })
    return normalizeGeneratedConversationTitle(text) || fallbackTitle
  } catch (error) {
    await logClientError(CHAT_TITLE_GENERATION_SCOPE, error, {
      model,
      baseUrl,
    })
    return fallbackTitle
  }
}
