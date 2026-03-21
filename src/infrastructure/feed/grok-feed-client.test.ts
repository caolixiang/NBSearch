import { describe, expect, it } from "bun:test"
import { buildFeedFetchPrompt, parseFeedGatewayPosts } from "./grok-feed-client"

describe("grok feed client prompt", () => {
  it("pins the account URL, output schema, and JSON-only contract", () => {
    const prompt = buildFeedFetchPrompt("kalshi")

    expect(prompt).toContain("https://x.com/Kalshi")
    expect(prompt).toContain('"account":"@Account"')
    expect(prompt).toContain("latest_posts")
    expect(prompt).toContain("extra_with_media")
    expect(prompt).toContain("不要输出 Markdown 代码块")
  })
})

describe("parseFeedGatewayPosts", () => {
  it("parses gateway JSON output, keeps canonical URLs, and deduplicates repeated ids", () => {
    const posts = parseFeedGatewayPosts(
      JSON.stringify({
        id: "resp_feed_1",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: `\`\`\`json
{
  "account": "@Kalshi",
  "latest_posts": [
    {
      "id": "2034991514116661465",
      "timestamp": "2026-03-20T13:52:39Z",
      "content": "BREAKING: Trump calls NATO members cowards",
      "engagement": {
        "likes": 103,
        "reposts": 12,
        "quotes": 3,
        "replies": 35,
        "views": 4786
      },
      "has_media": false
    },
    {
      "id": "2034775020795306177",
      "timestamp": "2026-03-19T23:32:23Z",
      "content": "Kalshi 🤝 Speed 🤝 Baller League",
      "engagement": {
        "likes": 1248,
        "reposts": 56,
        "quotes": 20,
        "replies": 52,
        "views": 337545
      },
      "has_media": true,
      "media_urls": [
        "https://video.twimg.com/amplify_video/2034774911852359680/vid/avc1/468x270/ZrEQ6lFG_uB4vuqa.mp4"
      ]
    }
  ],
  "extra_with_media": [
    {
      "id": "2034775020795306177",
      "timestamp": "2026-03-19T23:32:23Z",
      "content": "Kalshi 🤝 Speed 🤝 Baller League",
      "engagement": {
        "likes": 1248,
        "reposts": 56,
        "quotes": 20,
        "replies": 52,
        "views": 337545
      },
      "has_media": true,
      "media_urls": [
        "https://video.twimg.com/amplify_video/2034774911852359680/vid/avc1/468x270/ZrEQ6lFG_uB4vuqa.mp4"
      ]
    },
    {
      "id": "2034629905506263135",
      "timestamp": "2026-03-19T13:55:45Z",
      "content": "$1 Billion for a perfect bracket",
      "engagement": {
        "likes": 999,
        "reposts": 10,
        "quotes": 5,
        "replies": 7,
        "views": 10000
      },
      "has_media": true,
      "media_urls": [
        "https://pbs.twimg.com/media/HDx0YM3bsAAGglu.jpg"
      ]
    }
  ],
  "note": "最新 5 条主帖 + 较新的带媒体旧帖"
}
\`\`\``,
              },
            ],
          },
        ],
      }),
      "kalshi"
    )

    expect(posts).toHaveLength(3)
    expect(posts[0]).toMatchObject({
      postId: "2034991514116661465",
      canonicalUrl: "https://x.com/Kalshi/status/2034991514116661465",
      mediaUrls: [],
    })
    expect(posts[1]?.mediaUrls).toEqual([
      "https://video.twimg.com/amplify_video/2034774911852359680/vid/avc1/468x270/ZrEQ6lFG_uB4vuqa.mp4",
    ])
    expect(posts[2]?.canonicalUrl).toBe("https://x.com/Kalshi/status/2034629905506263135")
  })

  it("rejects mismatched accounts so one source cannot poison another", () => {
    expect(() =>
      parseFeedGatewayPosts(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: '{"account":"@Kalshi","latest_posts":[{"id":"1","timestamp":"2026-03-20T13:52:39Z","content":"post","engagement":{"likes":0,"reposts":0,"quotes":0,"replies":0,"views":0},"has_media":false}],"extra_with_media":[],"note":"x"}',
                },
              ],
            },
          ],
        }),
        "polymarket"
      )
    ).toThrow("错误账号")
  })
})
