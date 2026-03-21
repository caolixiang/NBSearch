import { describe, expect, it } from "bun:test"
import {
  FEED_AUTOLOAD_ROOT_MARGIN,
  getFeedItemContent,
  getFeedSourceHandleLabel,
  getFeedItemTitle,
  hasFeedSourceWordmark,
  normalizeFeedCardText,
  shouldAutoLoadFeedPage,
} from "./polymarket-feed-pane"

describe("FeedPane auto load", () => {
  it("auto-loads only when subscription is enabled, more items exist, and a page is not already loading", () => {
    expect(
      shouldAutoLoadFeedPage({
        subscriptionEnabled: true,
        hasMore: true,
        isLoading: false,
      })
    ).toBe(true)

    expect(
      shouldAutoLoadFeedPage({
        subscriptionEnabled: false,
        hasMore: true,
        isLoading: false,
      })
    ).toBe(false)

    expect(
      shouldAutoLoadFeedPage({
        subscriptionEnabled: true,
        hasMore: false,
        isLoading: false,
      })
    ).toBe(false)

    expect(
      shouldAutoLoadFeedPage({
        subscriptionEnabled: true,
        hasMore: true,
        isLoading: true,
      })
    ).toBe(false)
  })

  it("uses a generous bottom root margin so the next page begins loading before the user hard-stops at the end", () => {
    expect(FEED_AUTOLOAD_ROOT_MARGIN).toBe("0px 0px 160px 0px")
  })

  it("normalizes card text by trimming trailing blanks and collapsing extra empty lines", () => {
    expect(normalizeFeedCardText("标题\n\n\n\n正文\n\n")).toBe("标题\n\n正文")
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

    expect(getFeedItemTitle(item)).toBe("刚刚：谷歌推出 AI vibe design 工具后，Figma 股价单日暴跌 8%。")
    expect(getFeedItemContent(item)).toBe("")
  })

  it("keeps branded sources on the wordmark path and formats non-branded sources as @handles", () => {
    expect(hasFeedSourceWordmark("polymarket")).toBe(true)
    expect(hasFeedSourceWordmark("kalshi")).toBe(true)
    expect(getFeedSourceHandleLabel("elonmusk")).toBe("@elonmusk")
  })
})
