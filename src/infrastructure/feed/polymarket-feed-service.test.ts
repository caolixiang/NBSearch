import { describe, expect, it } from "bun:test"
import type { AppConfig } from "@/app/contracts"
import type { FeedSource } from "@/domain/feed/types"
import { MemoryAppRepository } from "@/infrastructure/storage/memory/repository"
import type { FeedFetchClient, FeedFetchPost } from "./grok-feed-client"
import type {
  FeedTranslationRequest,
  FeedTranslationResult,
  FeedTranslator,
} from "./openai-feed-translator"
import { FeedSyncService } from "./polymarket-feed-service"

class FakeFeedFetchClient implements FeedFetchClient {
  constructor(private readonly payloadBySource: Record<FeedSource, FeedFetchPost[]>) {}

  async fetchPosts(source: FeedSource): Promise<FeedFetchPost[]> {
    return this.payloadBySource[source]
  }
}

class FlakyFeedFetchClient implements FeedFetchClient {
  calls = 0

  constructor(
    private readonly payloadBySource: Record<FeedSource, FeedFetchPost[]>,
    private readonly failuresBeforeSuccess: number,
    private readonly errorMessage = "temporary feed fetch failure"
  ) {}

  async fetchPosts(source: FeedSource): Promise<FeedFetchPost[]> {
    this.calls += 1
    if (this.calls <= this.failuresBeforeSuccess) {
      throw new Error(this.errorMessage)
    }
    return this.payloadBySource[source]
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

const POLYMARKET_POSTS: FeedFetchPost[] = [
  {
    postId: "2034396261223440480",
    content: "BREAKING: Iceland says it could join the EU by 2028.",
    mediaUrls: ["https://pbs.twimg.com/media/HDugnRdWYAAiISC?format=jpg&name=small"],
    canonicalUrl: "https://x.com/Polymarket/status/2034396261223440480",
    publishedAt: 1779000000000,
  },
  {
    postId: "2034396000000000000",
    content: "JUST IN: Chinese Foreign Minister says China will continue mediating to push for a ceasefire.",
    mediaUrls: [],
    canonicalUrl: "https://x.com/Polymarket/status/2034396000000000000",
    publishedAt: 1778999999000,
  },
]

const KALSHI_POSTS: FeedFetchPost[] = [
  {
    postId: "2034976360163107270",
    content: "JUST IN: North Carolina introduces bill to establish strategic Bitcoin reserve",
    mediaUrls: [],
    canonicalUrl: "https://x.com/Kalshi/status/2034976360163107270",
    publishedAt: 1779000000000,
  },
]

function buildConfig(): AppConfig {
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

function buildClient(): FakeFeedFetchClient {
  return new FakeFeedFetchClient({
    polymarket: POLYMARKET_POSTS,
    kalshi: KALSHI_POSTS,
  })
}

describe("FeedSyncService", () => {
  it("syncs translated items, deduplicates and paginates feed items", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const service = new FeedSyncService(repository, buildConfig(), buildClient(), translator)

    const subscription = await service.getSubscription("polymarket")
    expect(subscription.enabled).toBe(true)
    expect(subscription.pollIntervalMinutes).toBe(30)

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
    const service = new FeedSyncService(repository, buildConfig(), buildClient(), translator)

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

  it("retries a failed sync attempt before surfacing success", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const client = new FlakyFeedFetchClient(
      {
        polymarket: POLYMARKET_POSTS,
        kalshi: KALSHI_POSTS,
      },
      1
    )
    const service = new FeedSyncService(repository, buildConfig(), client, translator, {
      syncRetryMaxAttempts: 3,
      syncRetryDelayMs: 0,
    })

    const result = await service.syncNow("polymarket")

    expect(client.calls).toBe(2)
    expect(result.insertedCount).toBe(2)
    const subscription = await service.getSubscription("polymarket")
    expect(subscription.lastError).toBe("")
    expect(subscription.lastSuccessAt).not.toBeNull()
  })

  it("keeps the final error after exhausting sync retries", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const client = new FlakyFeedFetchClient(
      {
        polymarket: POLYMARKET_POSTS,
        kalshi: KALSHI_POSTS,
      },
      3,
      "feed unavailable"
    )
    const service = new FeedSyncService(repository, buildConfig(), client, translator, {
      syncRetryMaxAttempts: 3,
      syncRetryDelayMs: 0,
    })

    try {
      await service.syncNow("polymarket")
      throw new Error("expected syncNow to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("feed unavailable")
    }
    expect(client.calls).toBe(3)

    const subscription = await service.getSubscription("polymarket")
    expect(subscription.lastError).toBe("feed unavailable")
    expect(subscription.lastSuccessAt).toBeNull()
  })

  it("supports syncing Kalshi as an independent source", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const service = new FeedSyncService(repository, buildConfig(), buildClient(), translator)

    const result = await service.syncNow("kalshi")
    expect(result.source).toBe("kalshi")
    expect(result.insertedCount).toBe(1)

    const page = await service.listItems({
      source: "kalshi",
      limit: 5,
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.source).toBe("kalshi")
    expect(page.items[0]?.title).toContain("North Carolina")
  })

  it("deduplicates by post id even when the fetched content changes later", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const client: FeedFetchClient = {
      async fetchPosts() {
        return [
          {
            postId: "2034991514116661465",
            content: firstCall ? "Version A" : "Version B after edit",
            mediaUrls: [],
            canonicalUrl: "https://x.com/Kalshi/status/2034991514116661465",
            publishedAt: 1779000000000,
          },
        ]
      },
    }
    let firstCall = true
    const wrappedClient: FeedFetchClient = {
      async fetchPosts(source) {
        const result = await client.fetchPosts(source)
        firstCall = false
        return result
      },
    }
    const service = new FeedSyncService(repository, buildConfig(), wrappedClient, translator)

    const firstSync = await service.syncNow("kalshi")
    const secondSync = await service.syncNow("kalshi")

    expect(firstSync.insertedCount).toBe(1)
    expect(secondSync.insertedCount).toBe(0)
    expect(translator.calls).toHaveLength(1)
  })

  it("cleans up feed items older than 48 hours by local discoveredAt", async () => {
    const repository = new MemoryAppRepository()
    const translator = new FakeFeedTranslator()
    const now = Date.now()
    await repository.insertFeedItems([
      {
        id: "feed_item_polymarket_stale",
        subscriptionId: "feed_sub_polymarket",
        source: "polymarket",
        contentHash: "hash_stale",
        title: "Stale",
        contentMarkdown: "Stale body",
        titleZh: "",
        contentMarkdownZh: "",
        translationStatus: "skipped",
        translationModel: "",
        translatedAt: null,
        mediaUrls: [],
        canonicalUrl: "https://x.com/Polymarket/status/stale",
        publishedAt: now - 7 * 24 * 60 * 60 * 1000,
        discoveredAt: now - 49 * 60 * 60 * 1000,
        fetchedAt: now - 49 * 60 * 60 * 1000,
      },
    ])

    const service = new FeedSyncService(repository, buildConfig(), buildClient(), translator)
    await service.syncNow("polymarket")

    const page = await service.listItems({
      source: "polymarket",
      limit: 10,
    })

    expect(page.items.some((item) => item.id === "feed_item_polymarket_stale")).toBe(false)
    expect(page.items).toHaveLength(2)
  })
})
