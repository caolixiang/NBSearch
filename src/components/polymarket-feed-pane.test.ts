import { describe, expect, it } from "bun:test"
import {
  POLYMARKET_FEED_AUTOLOAD_ROOT_MARGIN,
  getPolymarketItemContent,
  getPolymarketItemTitle,
  normalizePolymarketCardText,
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

  it("normalizes card text by trimming trailing blanks and collapsing extra empty lines", () => {
    expect(normalizePolymarketCardText("标题\n\n\n\n正文\n\n")).toBe("标题\n\n正文")
  })

  it("hides duplicated body text when it matches the title after normalization", () => {
    const item = {
      id: "feed_1",
      subscriptionId: "sub_1",
      source: "polymarket" as const,
      contentHash: "hash_1",
      title: "Original title",
      contentMarkdown: "Original title",
      titleZh: "刚刚：谷歌推出 AI vibe design 工具后，Figma 股价单日暴跌 8%。",
      contentMarkdownZh: "刚刚：谷歌推出 AI vibe design 工具后，Figma 股价单日暴跌 8%。\n\n\n",
      translationStatus: "translated" as const,
      translationModel: "gpt-5.4-mini",
      translatedAt: 1,
      mediaUrls: [],
      canonicalUrl: "",
      publishedAt: 1,
      discoveredAt: 1,
      fetchedAt: 1,
    }

    expect(getPolymarketItemTitle(item)).toBe("刚刚：谷歌推出 AI vibe design 工具后，Figma 股价单日暴跌 8%。")
    expect(getPolymarketItemContent(item)).toBe("")
  })
})
