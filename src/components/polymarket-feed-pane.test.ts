import { describe, expect, it } from "bun:test"
import {
  POLYMARKET_FEED_AUTOLOAD_ROOT_MARGIN,
  shouldAutoLoadPolymarketPage,
} from "./polymarket-feed-pane"

describe("PolymarketFeedPane auto load", () => {
  it("auto-loads only when subscription is enabled, more items exist, and a page is not already loading", () => {
    expect(
      shouldAutoLoadPolymarketPage({
        subscriptionEnabled: true,
        hasMore: true,
        isLoading: false,
      })
    ).toBe(true)

    expect(
      shouldAutoLoadPolymarketPage({
        subscriptionEnabled: false,
        hasMore: true,
        isLoading: false,
      })
    ).toBe(false)

    expect(
      shouldAutoLoadPolymarketPage({
        subscriptionEnabled: true,
        hasMore: false,
        isLoading: false,
      })
    ).toBe(false)

    expect(
      shouldAutoLoadPolymarketPage({
        subscriptionEnabled: true,
        hasMore: true,
        isLoading: true,
      })
    ).toBe(false)
  })

  it("uses a generous bottom root margin so the next page begins loading before the user hard-stops at the end", () => {
    expect(POLYMARKET_FEED_AUTOLOAD_ROOT_MARGIN).toBe("0px 0px 160px 0px")
  })
})
