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

  it("renews with local image_<sha256> asset id when card stores upstream uuid", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
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
    })

    const mockedFetch = (async () => createPendingStreamingResponse()) as unknown as typeof fetch
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

  it("retries once on initial idle timeout and preserves previous_response_id", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
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
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
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
    expect(parsedRequestBodies.every((payload) => payload["previous_response_id"] === "resp_prev_42")).toBe(true)
  })

  it("sends x_grok regenerate payload without appending a new user message", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      voiceEnabled: false,
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
    expect(body["previous_response_id"]).toBe("resp_prev_deep")
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
    expect(assistant?.research?.thinkingStartTime).toBe(new Date("2026-03-03T10:00:00Z").toISOString())
    expect(assistant?.research?.thinkingEndTime).toBe(new Date("2026-03-03T10:00:09Z").toISOString())
  })
})
