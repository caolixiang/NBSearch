import { describe, expect, it } from "bun:test"
import type { AppConfig } from "@/app/contracts"
import { MemoryAppRepository } from "@/infrastructure/storage/memory/repository"
import type { JinaReaderClient } from "./jina-reader-client"
import type { FeedTranslationRequest, FeedTranslationResult, FeedTranslator } from "./openai-feed-translator"
import { PolymarketFeedService } from "./polymarket-feed-service"

class FakeJinaReaderClient implements JinaReaderClient {
  constructor(private readonly payload: string) {}

  async fetchPolymarketTimeline(): Promise<string> {
    return this.payload
  }
}

class FakeFeedTranslator implements FeedTranslator {
  calls: FeedTranslationRequest[][] = []

  async translateMany(items: FeedTranslationRequest[]): Promise<FeedTranslationResult[]> {
    this.calls.push(items)
    return items.map((item) => ({
      contentHash: item.contentHash,
      titleZh: `[中文] ${item.title}`,
      contentMarkdownZh: `[中文] ${item.contentMarkdown}`,
      status: "translated",
      model: "gpt-5.4-mini",
      translatedAt: 1779000000000,
    }))
  }
}

class FlakyFeedTranslator implements FeedTranslator {
  calls: FeedTranslationRequest[][] = []

  async translateMany(items: FeedTranslationRequest[]): Promise<FeedTranslationResult[]> {
    this.calls.push(items)
    const callIndex = this.calls.length
    return items.map((item) => ({
      contentHash: item.contentHash,
      titleZh: callIndex === 1 ? "" : `[回填] ${item.title}`,
      contentMarkdownZh: callIndex === 1 ? "" : `[回填] ${item.contentMarkdown}`,
      status: callIndex === 1 ? "failed" : "translated",
      model: "gpt-5.4-mini",
      translatedAt: callIndex === 1 ? null : 1779000000123,
    }))
  }
}

const SAMPLE_TIMELINE = `Markdown Content:
## Polymarket’s posts

[![Image 7: Square profile picture](https://pbs.twimg.com/profile_images/2005664281002491904/bz2ZO_nU_normal.jpg)](https://x.com/Polymarket)
BREAKING: Iceland says it could join the EU by 2028.

[![Image 14: Image](https://pbs.twimg.com/media/HDugnRdWYAAiISC?format=jpg&name=small)](https://x.com/Polymarket/status/2034396261223440480/photo/1)

[![Image 8: Square profile picture](https://pbs.twimg.com/profile_images/2005664281002491904/bz2ZO_nU_normal.jpg)](https://x.com/Polymarket)
JUST IN: Chinese Foreign Minister says China will continue mediating to push for a ceasefire.
`

function buildConfig(): AppConfig {
  return {
    apiBaseUrl: "",
    apiKey: "",
    defaultModel: "grok-4.1-fast",
      openaiApiBaseUrl: "https://cpabak.zeabur.app/v1",
      openaiApiKey: "",
      openaiTranslationModel: "gpt-5.4-mini",
    voiceEnabled: true,
    polymarketSubscriptionEnabled: true,
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
  }
}

describe("PolymarketFeedService", () => {
  it("syncs translated items, deduplicates and paginates feed items", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const service = new PolymarketFeedService(
      repository,
      buildConfig(),
      new FakeJinaReaderClient(SAMPLE_TIMELINE),
      translator
    )

    const subscription = await service.getSubscription("polymarket")
    expect(subscription.enabled).toBe(true)

    const firstSync = await service.syncNow("polymarket")
    expect(firstSync.insertedCount).toBe(2)

    const secondSync = await service.syncNow("polymarket")
    expect(secondSync.insertedCount).toBe(0)
    expect(translator.calls).toHaveLength(1)
    expect(translator.calls[0]).toHaveLength(2)

    const firstPage = await service.listItems({
      source: "polymarket",
      limit: 1,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.items[0]?.translationStatus).toBe("translated")
    expect(firstPage.items[0]?.titleZh.startsWith("[中文]")).toBe(true)

    const secondPage = await service.listItems({
      source: "polymarket",
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
  })

  it("backfills older failed translations on the next sync", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FlakyFeedTranslator()
    const service = new PolymarketFeedService(
      repository,
      buildConfig(),
      new FakeJinaReaderClient(SAMPLE_TIMELINE),
      translator
    )

    await service.syncNow("polymarket")

    const firstPage = await service.listItems({
      source: "polymarket",
      limit: 5,
    })
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.items.every((item) => item.translationStatus === "failed")).toBe(true)

    await service.syncNow("polymarket")

    const secondPage = await service.listItems({
      source: "polymarket",
      limit: 5,
    })
    expect(translator.calls).toHaveLength(2)
    expect(translator.calls[0]).toHaveLength(2)
    expect(translator.calls[1]).toHaveLength(2)
    expect(secondPage.items.every((item) => item.translationStatus === "translated")).toBe(true)
    expect(secondPage.items.every((item) => item.titleZh.startsWith("[回填]"))).toBe(true)
  })
})
