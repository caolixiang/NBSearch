import { describe, expect, it } from "bun:test"
import { parseKalshiTimeline, parsePolymarketTimeline } from "./polymarket-timeline-parser"

const SAMPLE_TIMELINE = `Title: Polymarket (@Polymarket) / X

URL Source: https://x.com/Polymarket

Markdown Content:
[![Image 1: Square profile picture and Opens profile photo](https://pbs.twimg.com/profile_images/2005664281002491904/bz2ZO_nU_200x200.jpg)](https://x.com/Polymarket/photo)

Polymarket

@Polymarket

## Polymarket’s posts

Pinned

[![Image 2: Square profile picture](https://pbs.twimg.com/profile_images/2005664281002491904/bz2ZO_nU_normal.jpg)](https://x.com/Polymarket)

We're excited to announce 'The Situation Room' by Polymarket is coming to Washington, D.C.

[![Image 4: Image](https://pbs.twimg.com/media/HDsqRiyWoAAPpeu?format=jpg&name=small)](https://x.com/Polymarket/status/2034272538465841410/photo/1)

[![Image 5: Square profile picture](https://pbs.twimg.com/profile_images/2005664281002491904/bz2ZO_nU_normal.jpg)](https://x.com/Polymarket)

![Image 6: 🚨](https://abs-0.twimg.com/emoji/v2/svg/1f6a8.svg) NEW POLYMARKET: SEC removes quarterly reporting requirement?

[![Image 7: Square profile picture](https://pbs.twimg.com/profile_images/2005664281002491904/bz2ZO_nU_normal.jpg)](https://x.com/Polymarket)

BREAKING: Iceland says it could join the EU by 2028.

[![Image 14: Image](https://pbs.twimg.com/media/HDugnRdWYAAiISC?format=jpg&name=small)](https://x.com/Polymarket/status/2034396261223440480/photo/1)
`

const KALSHI_TIMELINE = `Title: Kalshi (@Kalshi) / X

URL Source: https://x.com/Kalshi

Markdown Content:
## Kalshi’s posts

Pinned

[![Image 2: Square profile picture](https://pbs.twimg.com/profile_images/2026716397598867456/cTZJLMxV_normal.jpg)](https://x.com/Kalshi)
The $1 Billion Kalshi Perfect Bracket Challenge

[![Image 7: Square profile picture](https://pbs.twimg.com/profile_images/2026716397598867456/cTZJLMxV_normal.jpg)](https://x.com/Kalshi)
BREAKING: Democrats and Republicans are now tied at 50% to win the Senate.

[![Image 9: Image](https://pbs.twimg.com/media/HDy9-jGXcAAndRK?format=jpg&name=360x360)](https://x.com/Kalshi/status/2034710018516279768/photo/1)
`

const KALSHI_TIMELINE_WITH_FOOTER = `Title: Kalshi (@Kalshi) / X

URL Source: http://x.com/Kalshi

Markdown Content:
[![Image 7: Square profile picture](https://pbs.twimg.com/profile_images/2026716397598867456/cTZJLMxV_normal.jpg)](http://x.com/Kalshi)
[Kalshi](http://x.com/Kalshi)
[@Kalshi](http://x.com/Kalshi)
·
JUST IN: Top 20% of American earners now hold 87% of all equities and mutual funds
[4K](http://x.com/Kalshi/status/2034976360163107270/analytics)

## X 新用户？

立即注册，获取你自己的个性化时间线！

使用 Apple 注册

[创建账户](http://x.com/i/flow/signup)

注册即表示你同意 [服务条款](https://x.com/tos) 和 [隐私政策](https://x.com/privacy)，包括 [Cookie 使用。](https://help.x.com/rules-and-policies/twitter-cookies)

[服务条款](https://x.com/tos)

|

[隐私政策](https://x.com/privacy)

|

[Cookie 政策](https://support.x.com/articles/20170514)

|

更多

© 2026 X Corp.
`

describe("parsePolymarketTimeline", () => {
  it("skips pinned items and keeps newer timeline blocks", () => {
    const items = parsePolymarketTimeline(SAMPLE_TIMELINE)

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: "🚨 NEW POLYMARKET: SEC removes quarterly reporting requirement?",
      contentMarkdown: "🚨 NEW POLYMARKET: SEC removes quarterly reporting requirement?",
      canonicalUrl: "",
    })
    expect(items[1]).toMatchObject({
      title: "BREAKING: Iceland says it could join the EU by 2028.",
      canonicalUrl: "https://x.com/Polymarket/status/2034396261223440480",
    })
    expect(items[1]?.mediaUrls).toEqual([
      "https://pbs.twimg.com/media/HDugnRdWYAAiISC?format=jpg&name=small",
    ])
  })

  it("parses Kalshi timelines with the same rules", () => {
    const items = parseKalshiTimeline(KALSHI_TIMELINE)

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: "BREAKING: Democrats and Republicans are now tied at 50% to win the Senate.",
      canonicalUrl: "https://x.com/Kalshi/status/2034710018516279768",
    })
    expect(items[0]?.mediaUrls).toEqual([
      "https://pbs.twimg.com/media/HDy9-jGXcAAndRK?format=jpg&name=360x360",
    ])
  })

  it("filters X login footer noise from the last Kalshi item", () => {
    const items = parseKalshiTimeline(KALSHI_TIMELINE_WITH_FOOTER)

    expect(items).toHaveLength(1)
    expect(items[0]?.contentMarkdown).toBe(
      "JUST IN: Top 20% of American earners now hold 87% of all equities and mutual funds"
    )
    expect(items[0]?.contentMarkdown.includes("X 新用户")).toBe(false)
    expect(items[0]?.contentMarkdown.includes("服务条款")).toBe(false)
    expect(items[0]?.contentMarkdown.includes("X Corp")).toBe(false)
  })
})
