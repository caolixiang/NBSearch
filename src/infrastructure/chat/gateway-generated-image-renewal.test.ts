import { describe, expect, it } from "bun:test"
import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import { hydrateGeneratedImageCardsFromGateway, renewGeneratedAssetUrlFromGateway } from "./gateway-generated-image-renewal"

function createAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: "Bearer test-key",
    ...(extra || {}),
  }
}

describe("gateway generated image renewal", () => {
  it("renews asset url from gateway", async () => {
    const calls: string[] = []
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      return new Response(
        JSON.stringify({
          asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          raw_url: "https://assets.grok.com/users/u-1/generated/image_abc/image.jpg",
          url: "https://signed.example.com/image.jpg?sig=1",
          url_expires_at: 1772411111,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    }) as unknown as typeof fetch

    const renewed = await renewGeneratedAssetUrlFromGateway({
      gatewayBaseUrl: "http://127.0.0.1:8787/v1",
      runtimeFetch: mockedFetch,
      createAuthHeaders,
      assetId: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })

    expect(calls).toEqual(["http://127.0.0.1:8787/v1/assets/image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/url?ttl=7200"])
    expect(renewed).toEqual({
      assetId: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rawUrl: "https://assets.grok.com/users/u-1/generated/image_abc/image.jpg",
      url: "https://signed.example.com/image.jpg?sig=1",
      urlExpiresAt: new Date(1772411111 * 1000).toISOString(),
    })
  })

  it("hydrates generated image cards and reuses renew cache", async () => {
    const calls: string[] = []
    const cards: ChatCardAttachmentPayload[] = [
      {
        id: "card_1",
        cardType: "image_card",
        type: "generated_image",
        url: "https://signed.example.com/image.jpg?X-Amz-Date=20260308T000000Z&X-Amz-Expires=1",
        image: {
          original: "https://signed.example.com/image.jpg?X-Amz-Date=20260308T000000Z&X-Amz-Expires=1",
        },
        assetId: "upstream_uuid_1",
        asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/image_abc/image.jpg",
        urlExpiresAt: "2000-01-01T00:00:00.000Z",
      },
      {
        id: "card_2",
        cardType: "image_card",
        type: "generated_image",
        url: "https://signed.example.com/image.jpg?X-Amz-Date=20260308T000000Z&X-Amz-Expires=1",
        image: {
          original: "https://signed.example.com/image.jpg?X-Amz-Date=20260308T000000Z&X-Amz-Expires=1",
        },
        asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/image_abc/image.jpg",
        urlExpiresAt: "2000-01-01T00:00:00.000Z",
      },
    ]
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      return new Response(
        JSON.stringify({
          asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          raw_url: "https://assets.grok.com/users/u-1/generated/image_abc/image.jpg",
          url: "https://signed.example.com/image-renewed.jpg?sig=2",
          url_expires_at: 1772412222,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    }) as unknown as typeof fetch

    await hydrateGeneratedImageCardsFromGateway({
      cards,
      gatewayBaseUrl: "http://127.0.0.1:8787/v1",
      runtimeFetch: mockedFetch,
      createAuthHeaders,
      sharedRenewCache: new Map(),
    })

    expect(calls).toHaveLength(1)
    expect(cards[0]?.url).toBe("https://signed.example.com/image-renewed.jpg?sig=2")
    expect(cards[0]?.image?.original).toBe("https://signed.example.com/image-renewed.jpg?sig=2")
    expect(cards[1]?.url).toBe("https://signed.example.com/image-renewed.jpg?sig=2")
    expect(cards[1]?.image?.original).toBe("https://signed.example.com/image-renewed.jpg?sig=2")
  })

  it("skips non-generated or non-renewable cards", async () => {
    const cards: ChatCardAttachmentPayload[] = [
      {
        id: "card_1",
        cardType: "image_card",
        type: "searched_image",
        url: "https://example.com/a.jpg",
      },
      {
        id: "card_2",
        cardType: "image_card",
        type: "generated_image",
        url: "https://example.com/public.jpg",
        image: {
          original: "https://example.com/public.jpg",
        },
      },
    ]
    let called = false
    const mockedFetch = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await hydrateGeneratedImageCardsFromGateway({
      cards,
      gatewayBaseUrl: "http://127.0.0.1:8787/v1",
      runtimeFetch: mockedFetch,
      createAuthHeaders,
    })

    expect(called).toBe(false)
    expect(cards[0]?.url).toBe("https://example.com/a.jpg")
    expect(cards[1]?.url).toBe("https://example.com/public.jpg")
  })
})
