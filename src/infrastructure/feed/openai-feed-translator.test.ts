import { describe, expect, it } from "bun:test"
import type { AppConfig } from "@/app/contracts"
import { OpenAIFeedTranslator } from "./openai-feed-translator"

function buildConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    apiBaseUrl: "",
    apiKey: "",
    defaultModel: "grok-4.1-fast",
    openaiApiBaseUrl: "",
    openaiApiKey: "",
    openaiTranslationModel: "gpt-5.4-mini",
    voiceEnabled: true,
    polymarketSubscriptionEnabled: true,
    kalshiSubscriptionEnabled: true,
    feedCustomAccounts: [],
    themeMode: "light",
    fontSizeMode: "default",
    timezone: "Asia/Shanghai",
    streamIdleTimeoutMs: 20_000,
    streamIdleRetryMaxAttempts: 1,
    streamIdleRetryDelayMs: 450,
    turnRecoveryMessagesLimit: 100,
    turnRecoveryNotFoundRetryMaxAttempts: 1,
    turnRecoveryPollInProgressMaxAttempts: 2,
    turnRecoveryPollInProgressDelayMs: 700,
    turnInProgressRetryMaxAttempts: 1,
    turnInProgressRetryDelayMs: 600,
    ...overrides,
  }
}

describe("OpenAIFeedTranslator", () => {
  it("skips translation when base url is missing even if api key exists", async () => {
    const translator = new OpenAIFeedTranslator(
      buildConfig({
        openaiApiKey: "test-key",
        openaiApiBaseUrl: "",
      })
    )

    const result = await translator.translateMany([
      {
        contentHash: "hash_1",
        title: "Original headline",
        contentMarkdown: "Original body",
      },
    ])

    expect(result).toEqual([
      {
        contentHash: "hash_1",
        titleZh: "",
        contentMarkdownZh: "",
        status: "skipped",
        model: "",
        translatedAt: null,
      },
    ])
  })
})
