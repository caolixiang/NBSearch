import { describe, expect, it } from "bun:test"
import { parsePolymarketTimeline } from "./polymarket-timeline-parser"

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
})
