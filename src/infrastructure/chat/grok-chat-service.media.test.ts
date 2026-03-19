import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"

describe("listMessages asset url refresh", () => {
  it("rewrites markdown image urls when generated-image cards are renewed", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      apiBaseUrl: "http://127.0.0.1:8787",
      apiKey: "test-key",
      defaultModel: "grok-4.1-fast",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
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
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
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
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
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
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
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
