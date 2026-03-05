import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import {
  GrokChatService,
  inferGeneratedImageAssetId,
  parseRenewedAssetUrlResponse,
  resolveGatewayMediaUrl,
  shouldRenewCardAssetUrl,
} from "./grok-chat-service"

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  return Buffer.from(base64 + padding, "base64").toString("utf8")
}

function extractImageToken(url: string): string {
  const marker = "/images/"
  const idx = url.indexOf(marker)
  if (idx < 0) {
    return ""
  }
  return url.slice(idx + marker.length)
}

function createStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
      },
    }
  )
}

function createPendingStreamingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // Keep stream open to trigger idle timeout path in stream reader.
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
      },
    }
  )
}

function readHeaderValue(headers: HeadersInit | undefined, key: string): string {
  if (!headers) {
    return ""
  }
  const lower = key.toLowerCase()
  if (headers instanceof Headers) {
    return headers.get(key) || ""
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (name.toLowerCase() === lower) {
        return value
      }
    }
    return ""
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lower) {
      return value
    }
  }
  return ""
}

describe("resolveGatewayMediaUrl", () => {
  const gatewayApiUrl = "http://127.0.0.1:8787/v1/responses"

  it("maps generated relative asset path to /images/p_ token", () => {
    const raw = "users/abc/generated/img-1/image.jpg"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved.startsWith("http://127.0.0.1:8787/images/p_")).toBe(true)

    const token = extractImageToken(resolved)
    expect(token.startsWith("p_")).toBe(true)
    expect(decodeBase64Url(token.slice(2))).toBe("/users/abc/generated/img-1/image.jpg")
  })

  it("maps assets.grok absolute url to /images/u_ token", () => {
    const raw = "https://assets.grok.com/users/u-1/generated/g-1/image.jpg"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved.startsWith("http://127.0.0.1:8787/images/u_")).toBe(true)

    const token = extractImageToken(resolved)
    expect(token.startsWith("u_")).toBe(true)
    expect(decodeBase64Url(token.slice(2))).toBe(raw)
  })

  it("keeps external absolute image url as-is", () => {
    const raw = "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRwzbcIptLxYiHCT_ko5OV2fJxPBAjB7c33oA&s"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved).toBe(raw)
  })

  it("keeps existing gateway /images url", () => {
    const raw = "http://127.0.0.1:8787/images/image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved).toBe(raw)
  })
})

describe("parseRenewedAssetUrlResponse", () => {
  it("parses direct payload with snake_case keys", () => {
    const parsed = parseRenewedAssetUrlResponse({
      asset_id: "asset_1",
      raw_url: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/a.jpg?X-Amz-Signature=abc",
      url_expires_at: "2026-03-02T10:00:00Z",
    })

    expect(parsed).toEqual({
      assetId: "asset_1",
      rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/a.jpg?X-Amz-Signature=abc",
      urlExpiresAt: new Date("2026-03-02T10:00:00Z").toISOString(),
    })
  })

  it("parses wrapped payload", () => {
    const parsed = parseRenewedAssetUrlResponse({
      result: {
        response: {
          assetId: "asset_2",
          rawUrl: "https://assets.grok.com/users/u-1/generated/asset_2/image.jpg",
          url: "https://bucket.s3.ap-east-1.amazonaws.com/b.jpg?X-Amz-Signature=def",
          urlExpiresAt: "2026-03-02T11:00:00Z",
        },
      },
    })

    expect(parsed?.assetId).toBe("asset_2")
    expect(parsed?.url).toContain("b.jpg")
  })

  it("parses unix timestamp expires field", () => {
    const parsed = parseRenewedAssetUrlResponse({
      asset_id: "asset_3",
      raw_url: "https://assets.grok.com/users/u-1/generated/asset_3/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/c.jpg?X-Amz-Signature=ghi",
      url_expires_at: 1772411111,
    })

    expect(parsed).toEqual({
      assetId: "asset_3",
      rawUrl: "https://assets.grok.com/users/u-1/generated/asset_3/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/c.jpg?X-Amz-Signature=ghi",
      urlExpiresAt: new Date(1772411111 * 1000).toISOString(),
    })
  })

  it("infers expires_at from signed url when field is missing", () => {
    const parsed = parseRenewedAssetUrlResponse({
      asset_id: "asset_4",
      raw_url: "https://assets.grok.com/users/u-1/generated/asset_4/image.jpg",
      url: "https://s3.bitiful.net/grok/assets/image/2026/03/demo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test%2F20260302%2Fs3.bitiful.net%2Fs3%2Faws4_request&X-Amz-Date=20260302T020000Z&X-Amz-Expires=7200&X-Amz-Signature=abc&X-Amz-SignedHeaders=host",
    })

    expect(parsed?.assetId).toBe("asset_4")
    expect(parsed?.url).toContain("demo.jpg")
    expect(parsed?.urlExpiresAt).toBe(new Date("2026-03-02T04:00:00Z").toISOString())
  })
})

describe("shouldRenewCardAssetUrl", () => {
  it("requires refresh when url is expired", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "asset_1",
        asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
        url: "https://bucket.s3.amazonaws.com/a.jpg?X-Amz-Signature=abc",
        urlExpiresAt: "2026-03-02T00:00:00Z",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(true)
  })

  it("skips refresh when signed url is still valid", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "asset_1",
        asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
        url: "https://bucket.s3.amazonaws.com/a.jpg?X-Amz-Signature=abc",
        urlExpiresAt: "2026-03-02T02:30:00Z",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(false)
  })

  it("skips refresh for public url without expires_at", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/a/image.jpg",
        url: "https://cdn.example.com/generated/a.jpg",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(false)
  })

  it("skips refresh for local image proxy url without expires_at", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/a/image.jpg",
        url: "http://127.0.0.1:8787/images/image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(false)
  })
})

describe("inferGeneratedImageAssetId", () => {
  it("extracts asset id from generated image url", () => {
    const assetId = inferGeneratedImageAssetId(
      "https://assets.grok.com/users/u-1/generated/25da98c5-a40f-426f-86f2-5713538aa1b1/image.jpg"
    )
    expect(assetId).toBe("25da98c5-a40f-426f-86f2-5713538aa1b1")
  })

  it("extracts local image asset id from signed s3 url", () => {
    const assetId = inferGeneratedImageAssetId(
      "https://s3.bitiful.net/grok/assets/image/2026/03/738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23.jpg?X-Amz-Date=20260302T060955Z&X-Amz-Expires=7200"
    )
    expect(assetId).toBe("image_738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23")
  })
})

describe("listMessages asset url refresh", () => {
  it("rewrites markdown image urls when generated-image cards are renewed", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const expiredUrl = "https://s3.bitiful.net/grok/assets/image/2026/03/expired.jpg?X-Amz-Signature=old"
    const renewedUrl = "https://s3.bitiful.net/grok/assets/image/2026/03/renewed.jpg?X-Amz-Signature=new"
    const card = {
      id: "card_1",
      cardType: "image_card",
      type: "generated_image",
      url: expiredUrl,
      assetId: "asset_1",
      rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
      urlExpiresAt: "2026-03-02T00:00:00Z",
      image: {
        original: expiredUrl,
      },
    }
    const content = `![Generated Image](<${expiredUrl}>)\n<tool-meta>${JSON.stringify({
      webSearch: [],
      cards: [card],
    })}</tool-meta>`

    await repository.appendMessage("conv_1", {
      id: "asst_1",
      role: "assistant",
      content,
      reasoningEvents: [
        {
          kind: "card_attachment",
          card,
        },
      ],
      createdAt: 1,
      status: "completed",
    })

    const mockedFetch = (async () =>
      new Response(
        JSON.stringify({
          asset_id: "asset_1",
          raw_url: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
          url: renewedUrl,
          url_expires_at: 1772411111,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const messages = await service.listMessages("conv_1")
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toContain(`![Generated Image](<${renewedUrl}>)`)
    expect(messages[0]?.content).not.toContain(`![Generated Image](<${expiredUrl}>)`)

    const cardEvent = messages[0]?.reasoningEvents?.find((event) => event.kind === "card_attachment")
    if (!cardEvent || cardEvent.kind !== "card_attachment") {
      throw new Error("expected card attachment event")
    }
    expect(cardEvent.card.url).toBe(renewedUrl)
    expect(cardEvent.card.image?.original).toBe(renewedUrl)
    expect(cardEvent.card.urlExpiresAt).toBe(new Date(1772411111 * 1000).toISOString())

    const persisted = await repository.listMessages("conv_1")
    expect(persisted[0]?.content).toContain(`![Generated Image](<${renewedUrl}>)`)
  })

  it("restores missing generated-image cards from reasoning events", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const proxy1 = "http://127.0.0.1:8787/images/p_a"
    const proxy2 = "http://127.0.0.1:8787/images/p_b"
    const signed1 = "https://s3.bitiful.net/grok/assets/image/2026/03/a.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig1"
    const signed2 = "https://s3.bitiful.net/grok/assets/image/2026/03/b.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig2"

    const cards = [
      {
        id: "card_a",
        cardType: "image_card",
        type: "generated_image",
        url: proxy1,
        assetId: "asset_a",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_a/image.jpg",
        urlExpiresAt: "2026-03-03T00:00:00Z",
        image: { original: proxy1 },
      },
      {
        id: "card_b",
        cardType: "image_card",
        type: "generated_image",
        url: proxy2,
        assetId: "asset_b",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_b/image.jpg",
        urlExpiresAt: "2026-03-03T00:00:00Z",
        image: { original: proxy2 },
      },
    ]

    const content = [
      `![Generated Image](<${proxy1}>)`,
      `![Generated Image](<${proxy2}>)`,
      `<tool-meta>${JSON.stringify({ webSearch: [], cards })}</tool-meta>`,
    ].join("\n")

    await repository.appendMessage("conv_3", {
      id: "asst_3",
      role: "assistant",
      content,
      reasoningEvents: [
        {
          kind: "card_attachment",
          card: cards[0]!,
        },
        {
          kind: "card_attachment",
          card: cards[1]!,
        },
        {
          kind: "card_attachment",
          card: {
            id: "card_c",
            cardType: "image_card",
            type: "generated_image",
            url: signed1,
            image: { original: signed1 },
          },
        },
        {
          kind: "card_attachment",
          card: {
            id: "card_d",
            cardType: "image_card",
            type: "generated_image",
            url: signed2,
            image: { original: signed2 },
          },
        },
      ],
      createdAt: 3,
      status: "completed",
    })

    const mockedFetch = (async () =>
      new Response("{}", {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      })) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const messages = await service.listMessages("conv_3")
    expect(messages).toHaveLength(1)
    const next = messages[0]?.content || ""
    expect(next).toContain(`![Generated Image](<${proxy1}>)`)
    expect(next).toContain(`![Generated Image](<${proxy2}>)`)
    expect(next).toContain(signed1)
    expect(next).toContain(signed2)
  })

  it("deduplicates upstream+signed image cards for the same generated outputs", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const upstreamUuidA = "50af3a1a-2536-4d8c-9c92-862006299ab0"
    const upstreamUuidB = "ee18ec32-b401-4aaf-af60-2bf009765da9"
    const proxyA = "http://127.0.0.1:8787/images/p_upstream_a"
    const proxyB = "http://127.0.0.1:8787/images/p_upstream_b"
    const signedA =
      "https://s3.bitiful.net/grok/assets/image/2026/03/035505a797d8164aa39af237c242d5f114fb3c9a6af2a61c759b56de15856413.jpg?X-Amz-Signature=sigA"
    const signedB =
      "https://s3.bitiful.net/grok/assets/image/2026/03/0a5f5aadf0615e2710dbec0fff18879d4b5ff028b892d3ac6437444c91eb4599.jpg?X-Amz-Signature=sigB"

    const cards = [
      {
        id: "generated_image_proxy_a",
        cardType: "image_card",
        type: "generated_image",
        url: proxyA,
        assetId: upstreamUuidA,
        image: { original: proxyA },
      },
      {
        id: "generated_image_proxy_b",
        cardType: "image_card",
        type: "generated_image",
        url: proxyB,
        assetId: upstreamUuidB,
        image: { original: proxyB },
      },
      {
        id: "generated_image_signed_a",
        cardType: "image_card",
        type: "generated_image",
        url: signedA,
        asset_id: "image_035505a797d8164aa39af237c242d5f114fb3c9a6af2a61c759b56de15856413",
        rawUrl: `https://assets.grok.com/users/u-1/generated/${upstreamUuidA}/image.jpg`,
        urlExpiresAt: "2030-03-04T04:42:11.558Z",
        image: { original: signedA },
      },
      {
        id: "generated_image_signed_b",
        cardType: "image_card",
        type: "generated_image",
        url: signedB,
        asset_id: "image_0a5f5aadf0615e2710dbec0fff18879d4b5ff028b892d3ac6437444c91eb4599",
        rawUrl: `https://assets.grok.com/users/u-1/generated/${upstreamUuidB}/image.jpg`,
        urlExpiresAt: "2030-03-04T04:42:13.560Z",
        image: { original: signedB },
      },
    ]

    const content = [
      `![Generated Image](<${proxyA}>)`,
      `![Generated Image](<${proxyB}>)`,
      `![Generated Image](<${signedA}>)`,
      `![Generated Image](<${signedB}>)`,
      `<tool-meta>${JSON.stringify({ webSearch: [], cards })}</tool-meta>`,
    ].join("\n")

    await repository.appendMessage("conv_dedupe_1", {
      id: "asst_dedupe_1",
      role: "assistant",
      content,
      createdAt: 1,
      status: "completed",
    })

    const mockedFetch = (async () =>
      new Response("{}", {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      })) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const messages = await service.listMessages("conv_dedupe_1")
    expect(messages).toHaveLength(1)
    const next = messages[0]?.content || ""

    expect(next).toContain(`![Generated Image](<${signedA}>)`)
    expect(next).toContain(`![Generated Image](<${signedB}>)`)
    expect(next).not.toContain(`![Generated Image](<${proxyA}>)`)
    expect(next).not.toContain(`![Generated Image](<${proxyB}>)`)
    expect(next.match(/!\[Generated Image\]\(<[^>]+>\)/g) || []).toHaveLength(2)

    const payloadMatch = next.match(/<tool-meta>([\s\S]*?)<\/tool-meta>/i)
    if (!payloadMatch?.[1]) {
      throw new Error("expected tool-meta payload")
    }
    const payload = JSON.parse(payloadMatch[1]) as { cards?: Array<{ url?: string }> }
    const nextCards = payload.cards || []
    expect(nextCards).toHaveLength(2)
    expect(nextCards.map((item) => item.url)).toEqual([signedA, signedB])
  })

  it("renews with local image_<sha256> asset id when card stores upstream uuid", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const upstreamUuid = "98aabd8f-a6a9-42a0-b154-5b637ce79e12"
    const renewAssetId = "image_738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23"
    const rawUrl = `https://assets.grok.com/users/u-1/generated/${upstreamUuid}/image.jpg`
    const expiredUrl = `https://s3.bitiful.net/grok/assets/image/2026/03/738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23.jpg?X-Amz-Date=20260302T060955Z&X-Amz-Expires=7200&X-Amz-Signature=old`
    const renewedUrl = `https://s3.bitiful.net/grok/assets/image/2026/03/738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23.jpg?X-Amz-Date=20260302T080955Z&X-Amz-Expires=7200&X-Amz-Signature=new`

    const card = {
      id: "card_uuid",
      cardType: "image_card",
      type: "generated_image",
      url: expiredUrl,
      assetId: upstreamUuid,
      rawUrl,
      urlExpiresAt: "2020-03-02T08:00:00Z",
      image: {
        original: expiredUrl,
      },
    }

    await repository.appendMessage("conv_uuid", {
      id: "asst_uuid",
      role: "assistant",
      content: `![Generated Image](<${expiredUrl}>)\n<tool-meta>${JSON.stringify({ webSearch: [], cards: [card] })}</tool-meta>`,
      reasoningEvents: [{ kind: "card_attachment", card }],
      createdAt: 1,
      status: "completed",
    })

    const calledUrls: string[] = []
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calledUrls.push(url)
      return new Response(
        JSON.stringify({
          asset_id: renewAssetId,
          raw_url: rawUrl,
          url: renewedUrl,
          url_expires_at: "2026-03-02T10:00:00Z",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const messages = await service.listMessages("conv_uuid")
    expect(messages).toHaveLength(1)
    expect(calledUrls.some((url) => url.includes(`/assets/${renewAssetId}/url?ttl=7200`))).toBe(true)
    expect(calledUrls.some((url) => url.includes(`/assets/${upstreamUuid}/url?ttl=7200`))).toBe(false)
    const cardEvent = messages[0]?.reasoningEvents?.find((event) => event.kind === "card_attachment")
    if (!cardEvent || cardEvent.kind !== "card_attachment") {
      throw new Error("expected normalized card attachment event")
    }
    expect(cardEvent.card.assetId).toBe(upstreamUuid)
    expect(cardEvent.card.asset_id).toBe(renewAssetId)
  })

})

describe("streamTurn heartbeats and timeout", () => {
  it("emits heartbeat and monotonic meta sequence on a normal stream", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_meta_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Hello",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_meta_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Hello",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const mockedFetch = (async () => createStreamingResponse([streamChunk])) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{
      type: string
      meta: { seq: number; conversationId: string; responseId?: string }
      code?: string
      result?: { assistantMessage?: { content: string } }
    }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "hello",
        anchors: {
          conversationId: "conv_meta_1",
          sessionId: "sess_meta_1",
          lastResponseId: "",
        },
      },
      (event) => {
        events.push(event)
      }
    )

    expect(events.length).toBeGreaterThan(0)
    expect(events.some((event) => event.type === "heartbeat")).toBe(true)
    expect(events.some((event) => event.type === "completed")).toBe(true)

    for (let index = 0; index < events.length; index += 1) {
      expect(events[index]?.meta.seq).toBe(index + 1)
      expect(events[index]?.meta.conversationId).toBe("conv_meta_1")
    }

    const completedEvent = events.find((event) => event.type === "completed")
    expect(completedEvent?.meta.responseId).toBe("resp_meta_1")
    expect(completedEvent?.result?.assistantMessage?.content).toContain("Hello")
  })

  it("emits stream_idle_timeout failure when stream reader stalls", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        return createPendingStreamingResponse()
      }
      return new Response(
        JSON.stringify({
          status: "not_found",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      return originalSetTimeout(() => {
        if (typeof handler === "function") {
          handler()
        }
      }, 0)
    }) as unknown as typeof setTimeout

    const events: Array<{ type: string; code?: string }> = []
    try {
      await service.streamTurn(
        {
          model: "grok-4.1-fast",
          text: "hello",
          anchors: {
            conversationId: "conv_timeout_1",
            sessionId: "sess_timeout_1",
            lastResponseId: "",
          },
        },
        (event) => {
          events.push(event)
        }
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    const failed = events.find((event) => event.type === "failed")
    expect(failed?.code).toBe("stream_idle_timeout")
    expect(events.some((event) => event.type === "completed")).toBe(false)
  })

  it("retries once on initial idle timeout and keeps idempotent client_turn_id", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_retry_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Recovered",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Recovered",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    let fetchCallCount = 0
    const requestBodies: string[] = []
    const idempotencyKeys: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      idempotencyKeys.push(readHeaderValue(init?.headers, "Idempotency-Key"))
      if (fetchCallCount === 1) {
        return createPendingStreamingResponse()
      }
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      return originalSetTimeout(() => {
        if (typeof handler === "function") {
          handler()
        }
      }, 0)
    }) as unknown as typeof setTimeout

    const events: Array<{ type: string; code?: string; result?: { assistantMessage?: { content: string } } }> = []
    try {
      await service.streamTurn(
        {
          model: "grok-4.1-fast",
          text: "retry please",
          anchors: {
            conversationId: "conv_retry_1",
            sessionId: "sess_retry_1",
            lastResponseId: "resp_prev_42",
          },
        },
        (event) => {
          events.push(event)
        }
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(fetchCallCount).toBe(2)
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const completed = events.find((event) => event.type === "completed")
    expect(completed?.result?.assistantMessage?.content).toContain("Recovered")

    const parsedRequestBodies = requestBodies
      .map((raw) => {
        try {
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .filter((payload) => Object.keys(payload).length > 0)
    expect(parsedRequestBodies).toHaveLength(2)
    const firstClientTurnId = (parsedRequestBodies[0]?.["client_turn_id"] as string) || ""
    const secondClientTurnId = (parsedRequestBodies[1]?.["client_turn_id"] as string) || ""
    expect(firstClientTurnId.length > 0).toBe(true)
    expect(secondClientTurnId).toBe(firstClientTurnId)
    expect(parsedRequestBodies.every((payload) => payload["previous_response_id"] === undefined)).toBe(true)
    expect(idempotencyKeys).toEqual([firstClientTurnId, firstClientTurnId])
  })

  it("does not retry idle timeout when configured retry budget is 0", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
      streamIdleRetryMaxAttempts: 0,
      streamIdleRetryDelayMs: 0,
    })

    let fetchCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        fetchCallCount += 1
        return createPendingStreamingResponse()
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler) => {
      return originalSetTimeout(() => {
        if (typeof handler === "function") {
          handler()
        }
      }, 0)
    }) as unknown as typeof setTimeout

    const events: Array<{ type: string; code?: string }> = []
    try {
      await service.streamTurn(
        {
          model: "grok-4.1-fast",
          text: "no idle retry",
          anchors: {
            conversationId: "conv_no_idle_retry_1",
            sessionId: "sess_no_idle_retry_1",
            lastResponseId: "resp_prev_no_idle_retry_1",
          },
        },
        (event) => {
          events.push(event)
        }
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(fetchCallCount).toBe(1)
    const failed = events.find((event) => event.type === "failed")
    expect(failed?.code).toBe("stream_idle_timeout")
  })

  it("retries once without previous_response_id on session anchor conflict", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_anchor_retry_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Recovered",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_anchor_retry_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Recovered",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    let fetchCallCount = 0
    const requestBodies: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      if (fetchCallCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "session_anchor_conflict",
              message: "previous_response_id does not match session anchor",
              type: "invalid_request_error",
            },
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{ type: string; code?: string; result?: { assistantMessage?: { content: string } } }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "retry please",
        anchors: {
          conversationId: "conv_anchor_retry_1",
          lastResponseId: "resp_prev_anchor_42",
        },
      },
      (event) => {
        events.push(event)
      }
    )

    expect(fetchCallCount).toBe(2)
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const completed = events.find((event) => event.type === "completed")
    expect(completed?.result?.assistantMessage?.content).toContain("Recovered")

    expect(requestBodies).toHaveLength(2)
    const firstBody = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    const secondBody = JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>
    expect(firstBody["previous_response_id"]).toBe("resp_prev_anchor_42")
    expect(secondBody["previous_response_id"]).toBeUndefined()
  })

  it("recovers completed turn from session APIs after transport failure", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const requestBodies: string[] = []
    const idempotencyKeys: string[] = []
    let fetchCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        idempotencyKeys.push(readHeaderValue(init?.headers, "Idempotency-Key"))
        throw new Error("network_failed")
      }
      if (url.includes("/v1/sessions/sess_recover_1/turns/turn_recover_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_1",
            client_turn_id: "turn_recover_1",
            status: "completed",
            response_id: "resp_recovered_1",
            updated_at: 1772670000001,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_1",
            messages: [
              {
                id: "resp_recovered_1",
                response_id: "resp_recovered_1",
                previous_response_id: "resp_prev_recover_1",
                role: "assistant",
                content: "Recovered from session API",
                status: "completed",
                client_turn_id: "turn_recover_1",
                created_at: 1772670000000,
              },
            ],
            has_more: false,
            next_after_response_id: "resp_recovered_1",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_1",
            last_response_id: "resp_recovered_1",
            in_progress: false,
            updated_at: 1772670000002,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{ type: string; code?: string; result?: { assistantMessage?: { content: string } } }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "recover me",
        anchors: {
          conversationId: "conv_recover_1",
          sessionId: "sess_recover_1",
          lastResponseId: "resp_prev_recover_1",
        },
        clientTurnId: "turn_recover_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(fetchCallCount).toBeGreaterThanOrEqual(4)
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const completed = events.find((event) => event.type === "completed")
    expect(completed?.result?.assistantMessage?.content).toContain("Recovered from session API")
    const requestPayload = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(requestPayload["client_turn_id"]).toBe("turn_recover_1")
    expect(idempotencyKeys[0]).toBe("turn_recover_1")
  })

  it("recovers pending assistant from session messages without resending", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const mockedFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/v1/sessions/sess_recover_pending_1/messages")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_1",
            messages: [
              {
                id: "msg_asst_recover_pending_1",
                response_id: "resp_recover_pending_1",
                previous_response_id: "resp_prev_pending_1",
                role: "assistant",
                content: "Recovered pending assistant",
                status: "completed",
                created_at: 1772670001000,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_recover_pending_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_recover_pending_1",
            last_response_id: "resp_recover_pending_1",
            in_progress: false,
            updated_at: 1772670001001,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const recovered = await service.recoverPendingAssistant({
      conversationId: "conv_recover_pending_1",
      anchors: {
        sessionId: "sess_recover_pending_1",
        lastResponseId: "resp_prev_pending_1",
      },
    })

    expect(recovered.recovered).toBe(true)
    expect(recovered.result?.assistantMessage.content).toContain("Recovered pending assistant")

    const messages = await repository.listMessages("conv_recover_pending_1")
    expect(messages.filter((item) => item.role === "assistant")).toHaveLength(1)
    expect(messages[0]?.responseId).toBe("resp_recover_pending_1")

    const conversations = await repository.listConversations()
    const conversation = conversations.find((item) => item.id === "conv_recover_pending_1")
    expect(conversation?.anchors.lastResponseId).toBe("resp_recover_pending_1")
  })

  it("retries original send once when turn status is not_found after transport failure", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_retry_notfound_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Retry succeeded",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry_notfound_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Retry succeeded",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    let fetchCallCount = 0
    const requestBodies: string[] = []
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        if (requestBodies.length === 1) {
          throw new Error("network_failed")
        }
        return createStreamingResponse([streamChunk])
      }
      if (url.includes("/v1/sessions/sess_retry_notfound_1/turns/turn_retry_notfound_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_notfound_1",
            client_turn_id: "turn_retry_notfound_1",
            status: "not_found",
            updated_at: 1772670000100,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{ type: string }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "retry not found",
        anchors: {
          conversationId: "conv_retry_notfound_1",
          sessionId: "sess_retry_notfound_1",
          lastResponseId: "resp_prev_retry_notfound_1",
        },
        clientTurnId: "turn_retry_notfound_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(fetchCallCount).toBe(3)
    expect(requestBodies).toHaveLength(2)
    const firstBody = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    const secondBody = JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>
    expect(firstBody["client_turn_id"]).toBe("turn_retry_notfound_1")
    expect(secondBody["client_turn_id"]).toBe("turn_retry_notfound_1")
    expect(events.some((event) => event.type === "completed")).toBe(true)
    const messages = await repository.listMessages("conv_retry_notfound_1")
    expect(messages.filter((item) => item.role === "user")).toHaveLength(1)
    expect(messages.filter((item) => item.role === "assistant")).toHaveLength(1)
  })

  it("retries same client turn when recovery reports in_progress and then succeeds", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_retry_inprogress_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Recovered after in-progress",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_retry_inprogress_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Recovered after in-progress",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const requestBodies: string[] = []
    let responsesCallCount = 0
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        responsesCallCount += 1
        if (responsesCallCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "session_in_progress",
                message: "session has an active turn",
                type: "invalid_request_error",
              },
            }),
            {
              status: 409,
              headers: {
                "Content-Type": "application/json",
              },
            }
          )
        }
        return createStreamingResponse([streamChunk])
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_1/turns/turn_retry_inprogress_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_1",
            client_turn_id: "turn_retry_inprogress_1",
            status: "in_progress",
            updated_at: 1772670000200,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_1",
            last_response_id: "resp_prev_retry_inprogress_1",
            in_progress: true,
            active_client_turn_id: "turn_retry_inprogress_1",
            updated_at: 1772670000201,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{ type: string; code?: string }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "recover from in progress",
        anchors: {
          conversationId: "conv_retry_inprogress_1",
          sessionId: "sess_retry_inprogress_1",
          lastResponseId: "resp_prev_retry_inprogress_1",
        },
        clientTurnId: "turn_retry_inprogress_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(requestBodies).toHaveLength(2)
    const firstBody = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    const secondBody = JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>
    expect(firstBody["client_turn_id"]).toBe("turn_retry_inprogress_1")
    expect(secondBody["client_turn_id"]).toBe("turn_retry_inprogress_1")
    expect(events.some((event) => event.type === "failed")).toBe(false)
    expect(events.some((event) => event.type === "completed")).toBe(true)
  })

  it("returns turn_in_progress immediately when configured in-progress retry budget is 0", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
      turnInProgressRetryMaxAttempts: 0,
      turnInProgressRetryDelayMs: 0,
    })

    const requestBodies: string[] = []
    const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        requestBodies.push(typeof init?.body === "string" ? init.body : "")
        return new Response(
          JSON.stringify({
            error: {
              code: "session_in_progress",
              message: "session has an active turn",
              type: "invalid_request_error",
            },
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_fail_1/turns/turn_retry_inprogress_fail_1")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_fail_1",
            client_turn_id: "turn_retry_inprogress_fail_1",
            status: "in_progress",
            updated_at: 1772670000300,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      if (url.includes("/v1/sessions/sess_retry_inprogress_fail_1/state")) {
        return new Response(
          JSON.stringify({
            session_id: "sess_retry_inprogress_fail_1",
            last_response_id: "resp_prev_retry_inprogress_fail_1",
            in_progress: true,
            active_client_turn_id: "turn_retry_inprogress_fail_1",
            updated_at: 1772670000301,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    const events: Array<{ type: string; code?: string }> = []
    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "in progress forever",
        anchors: {
          conversationId: "conv_retry_inprogress_fail_1",
          sessionId: "sess_retry_inprogress_fail_1",
          lastResponseId: "resp_prev_retry_inprogress_fail_1",
        },
        clientTurnId: "turn_retry_inprogress_fail_1",
      },
      (event) => {
        events.push(event)
      }
    )

    expect(requestBodies).toHaveLength(1)
    const failed = events.find((event) => event.type === "failed")
    expect(failed?.code).toBe("turn_in_progress")
  })

  it("sends previous_response_id when only response anchor is provided", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_no_session_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Answer",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_no_session_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Answer",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const requestBodies: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "hello",
        anchors: {
          conversationId: "conv_no_session_1",
          lastResponseId: "resp_prev_should_not_send",
        },
      },
      () => {}
    )

    expect(requestBodies).toHaveLength(1)
    const body = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(typeof body["session_id"]).toBe("string")
    expect(body["previous_response_id"]).toBe("resp_prev_should_not_send")
  })

  it("sends x_grok regenerate payload without appending a new user message", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_regen_1",
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Regenerated",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_regen_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Regenerated",
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const requestBodies: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "",
        anchors: {
          conversationId: "conv_regen_1",
          sessionId: "sess_regen_1",
          lastResponseId: "resp_parent_1",
        },
        regenerateTargetResponseId: "resp_target_3",
      },
      () => {}
    )

    expect(requestBodies).toHaveLength(1)
    const body = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(body["session_id"]).toBe("sess_regen_1")
    expect(body["input"]).toBeUndefined()
    expect(body["previous_response_id"]).toBeUndefined()
    expect(body["x_grok"]).toEqual({
      regenerate: true,
      target_response_id: "resp_target_3",
    })

    const messages = await repository.listMessages("conv_regen_1")
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe("assistant")
    expect(messages[0]?.content).toContain("Regenerated")
  })

  it("sends x_grok deep_search payload for deep-search turns", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const streamChunk = [
      JSON.stringify({
        type: "response.created",
        response: {
          id: "resp_deep_1",
        },
      }),
      JSON.stringify({
        result: {
          response: {
            cardAttachment: {
              jsonData:
                "{\"id\":\"citation_card_1\",\"cardType\":\"citation_card\",\"type\":\"render_inline_citation\",\"url\":\"https://en.wikipedia.org/wiki/Eileen_Gu\"}",
            },
            modelResponse: {
              steps: [
                { tags: ["header"], text: ["挖掘国籍细节"] },
                {
                  tags: ["summary"],
                  text: ["谷爱凌国籍争议及中美双重身份，引发公众讨论。"],
                },
              ],
              thinkingStartTime: "2026-03-03T10:00:00Z",
              thinkingEndTime: "2026-03-03T10:00:09Z",
            },
          },
        },
      }),
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "Deep result",
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_deep_1",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: [
                    "Deep result",
                    '<grok:render card_id="citation_card_1" card_type="citation_card" type="render_inline_citation">',
                    '<argument name="citation_id">6</argument>',
                    "</grok:render>",
                  ].join("\n"),
                },
              ],
            },
          ],
        },
      }),
    ].join("")

    const requestBodies: string[] = []
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      return createStreamingResponse([streamChunk])
    }) as unknown as typeof fetch
    ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
    ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch

    await service.streamTurn(
      {
        model: "grok-4.1-fast",
        text: "请深挖这个主题",
        anchors: {
          conversationId: "conv_deep_1",
          sessionId: "sess_deep_1",
          lastResponseId: "resp_prev_deep",
        },
        deepSearch: true,
      },
      () => {}
    )

    expect(requestBodies).toHaveLength(1)
    const body = JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>
    expect(body["session_id"]).toBe("sess_deep_1")
    expect(body["previous_response_id"]).toBeUndefined()
    expect(Array.isArray(body["input"])).toBe(true)
    expect(body["x_grok"]).toEqual({
      deep_search: true,
    })

    const messages = await repository.listMessages("conv_deep_1")
    const assistant = messages.find((item) => item.role === "assistant")
    expect(assistant?.research?.citationCards).toEqual([
      {
        cardId: "citation_card_1",
        cardType: "citation_card",
        url: "https://en.wikipedia.org/wiki/Eileen_Gu",
      },
    ])
    expect(assistant?.research?.inlineCitations).toEqual([
      {
        cardId: "citation_card_1",
        citationId: "6",
        url: undefined,
      },
    ])
    expect(assistant?.research?.details).toEqual([
      {
        title: "挖掘国籍细节",
        bullets: ["谷爱凌国籍争议及中美双重身份，引发公众讨论。"],
      },
    ])
    expect(assistant?.research?.steps).toEqual([
      {
        tags: ["header"],
        title: undefined,
        text: ["挖掘国籍细节"],
        toolUsageCardIds: undefined,
      },
      {
        tags: ["summary"],
        title: undefined,
        text: ["谷爱凌国籍争议及中美双重身份，引发公众讨论。"],
        toolUsageCardIds: undefined,
      },
    ])
    expect(assistant?.research?.thinkingStartTime).toBe(new Date("2026-03-03T10:00:00Z").toISOString())
    expect(assistant?.research?.thinkingEndTime).toBe(new Date("2026-03-03T10:00:09Z").toISOString())
  })
})
