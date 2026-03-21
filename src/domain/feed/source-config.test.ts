import { describe, expect, it } from "bun:test"
import {
  createCustomFeedSource,
  getFeedSourceConfig,
  normalizeFeedAccountHandle,
  normalizeFeedCustomAccounts,
  resolveConfiguredFeedSources,
} from "./source-config"

describe("feed source config", () => {
  it("normalizes direct handles and x.com urls into lowercase account handles", () => {
    expect(normalizeFeedAccountHandle("@ElonMusk")).toBe("elonmusk")
    expect(normalizeFeedAccountHandle("https://x.com/elonmusk")).toBe("elonmusk")
    expect(normalizeFeedAccountHandle("x.com/elonmusk/status/123")).toBe("elonmusk")
  })

  it("deduplicates custom accounts and filters built-in branded handles", () => {
    expect(
      normalizeFeedCustomAccounts([
        "@elonmusk",
        "https://x.com/ElonMusk",
        "Kalshi",
        "https://x.com/Polymarket",
      ])
    ).toEqual(["elonmusk"])
  })

  it("builds configured sources from branded defaults plus custom accounts", () => {
    expect(
      resolveConfiguredFeedSources({
        polymarketSubscriptionEnabled: true,
        kalshiSubscriptionEnabled: false,
        feedCustomAccounts: ["@elonmusk", "https://x.com/sama"],
      })
    ).toEqual(["polymarket", "kalshi", "x:elonmusk", "x:sama"])
  })

  it("derives custom source metadata from the source id", () => {
    const source = createCustomFeedSource("@elonmusk")

    expect(source).toBe("x:elonmusk")
    expect(getFeedSourceConfig(source)).toEqual({
      source: "x:elonmusk",
      label: "@elonmusk",
      accountHandle: "elonmusk",
      accountTag: "@elonmusk",
      profileUrl: "https://x.com/elonmusk",
      fallbackTitle: "@elonmusk 更新",
    })
  })
})
