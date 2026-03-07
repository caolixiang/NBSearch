import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import {
  finalizeGeneratedMediaArtifacts,
  refreshMessagesWithGeneratedMediaAssets,
} from "./gateway-media-workflows"

describe("finalizeGeneratedMediaArtifacts", () => {
  it("deduplicates generated cards and normalizes reasoning cards via the hydrator", async () => {
    const proxyUrl = "http://127.0.0.1:8787/images/p_proxy_demo"
    const signedUrl =
      "https://s3.bitiful.net/grok/assets/image/2026/03/renewed-demo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=renewed"
    const rawUrl = "https://assets.grok.com/users/u-1/generated/demo-asset/image.jpg"

    const result = await finalizeGeneratedMediaArtifacts({
      cards: [
        {
          id: "generated_proxy",
          cardType: "image_card",
          type: "generated_image",
          url: proxyUrl,
          assetId: "demo-asset",
          rawUrl,
          image: { original: proxyUrl },
        },
        {
          id: "generated_signed",
          cardType: "image_card",
          type: "generated_image",
          url: signedUrl,
          asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          rawUrl,
          urlExpiresAt: "2030-03-04T04:42:11.558Z",
          image: { original: signedUrl },
        },
      ],
      reasoningEvents: [
        {
          kind: "card_attachment",
          card: {
            id: "reasoning_card",
            cardType: "image_card",
            type: "generated_image",
            url: "https://s3.bitiful.net/grok/assets/image/2026/03/expired-demo.jpg?X-Amz-Signature=old",
            rawUrl,
            image: {
              original: "https://s3.bitiful.net/grok/assets/image/2026/03/expired-demo.jpg?X-Amz-Signature=old",
            },
          },
        },
      ],
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      hydrateGeneratedImageCards: async (cards) => {
        for (const card of cards) {
          if (card.id !== "reasoning_card") {
            continue
          }
          card.url = signedUrl
          card.image = { ...(card.image || {}), original: signedUrl }
          ;(card as unknown as Record<string, unknown>).rawUrl = rawUrl
          ;(card as unknown as Record<string, unknown>).asset_id =
            "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          ;(card as unknown as Record<string, unknown>).urlExpiresAt = "2030-03-04T04:42:11.558Z"
        }
      },
    })

    expect(result.cards).toHaveLength(1)
    expect(result.cards[0]?.id).toBe("generated_signed")
    const event = result.reasoningEvents?.[0]
    if (!event || event.kind !== "card_attachment") {
      throw new Error("expected card attachment reasoning event")
    }
    expect(event.card.url).toBe(signedUrl)
    expect(event.card.image?.original).toBe(signedUrl)
  })
})

describe("refreshMessagesWithGeneratedMediaAssets", () => {
  it("rewrites markdown, tool-meta and reasoning events after generated image renewal", async () => {
    const expiredUrl = "https://s3.bitiful.net/grok/assets/image/2026/03/expired.jpg?X-Amz-Signature=old"
    const renewedUrl = "https://s3.bitiful.net/grok/assets/image/2026/03/renewed.jpg?X-Amz-Signature=new"
    const message: ChatMessage = {
      id: "asst_refresh_1",
      role: "assistant",
      content: `![Generated Image](<${expiredUrl}>)\n<tool-meta>${JSON.stringify({
        webSearch: [],
        cards: [
          {
            id: "card_refresh_1",
            cardType: "image_card",
            type: "generated_image",
            url: expiredUrl,
            rawUrl: "https://assets.grok.com/users/u-1/generated/card_refresh_1/image.jpg",
            image: { original: expiredUrl },
          },
        ],
      })}</tool-meta>`,
      reasoningEvents: [
        {
          kind: "card_attachment",
          card: {
            id: "card_refresh_1",
            cardType: "image_card",
            type: "generated_image",
            url: expiredUrl,
            rawUrl: "https://assets.grok.com/users/u-1/generated/card_refresh_1/image.jpg",
            image: { original: expiredUrl },
          },
        },
      ],
      createdAt: 1,
      status: "completed",
    }

    const result = await refreshMessagesWithGeneratedMediaAssets({
      messages: [message],
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      hydrateGeneratedImageCards: async (cards) => {
        for (const card of cards) {
          card.url = renewedUrl
          card.image = { ...(card.image || {}), original: renewedUrl }
          ;(card as unknown as Record<string, unknown>).asset_id =
            "image_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          ;(card as unknown as Record<string, unknown>).urlExpiresAt = "2030-03-04T04:42:11.558Z"
        }
      },
    })

    expect(result.updated).toHaveLength(1)
    expect(result.messages[0]?.content).toContain(`![Generated Image](<${renewedUrl}>)`)
    expect(result.messages[0]?.content).not.toContain(`![Generated Image](<${expiredUrl}>)`)
    const event = result.messages[0]?.reasoningEvents?.[0]
    if (!event || event.kind !== "card_attachment") {
      throw new Error("expected refreshed card attachment reasoning event")
    }
    expect(event.card.url).toBe(renewedUrl)
    expect(event.card.image?.original).toBe(renewedUrl)
  })
})
