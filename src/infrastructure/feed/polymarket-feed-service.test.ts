import { describe, expect, it } from "bun:test"
import type { AppConfig } from "@/app/contracts"
import { MemoryAppRepository } from "@/infrastructure/storage/memory/repository"
import type { JinaReaderClient } from "./jina-reader-client"
import { PolymarketFeedService } from "./polymarket-feed-service"

class FakeJinaReaderClient implements JinaReaderClient {
  constructor(private readonly payload: string) {}

  async fetchPolymarketTimeline(): Promise<string> {
    return this.payload
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
  it("syncs, deduplicates and paginates feed items", async () => {
    const repository = new MemoryAppRepository()
    const service = new PolymarketFeedService(
      repository,
      buildConfig(),
      new FakeJinaReaderClient(SAMPLE_TIMELINE)
    )

    const subscription = await service.getSubscription("polymarket")
    expect(subscription.enabled).toBe(true)

    const firstSync = await service.syncNow("polymarket")
    expect(firstSync.insertedCount).toBe(2)

    const secondSync = await service.syncNow("polymarket")
    expect(secondSync.insertedCount).toBe(0)

    const firstPage = await service.listItems({
      source: "polymarket",
      limit: 1,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = await service.listItems({
      source: "polymarket",
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
  })
})
