import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "../storage/memory/repository"
import { createGatewayRecoveryRuntime } from "./gateway-recovery-runtime"

describe("createGatewayRecoveryRuntime", () => {
  it("creates bearer auth headers with extra fields", () => {
    const runtime = createGatewayRecoveryRuntime({
      repository: new MemoryAppRepository(),
      getGatewayBaseUrl: () => "http://127.0.0.1:8787/v1",
      getRuntimeFetch: () => fetch,
      getApiKey: () => "test-key",
      turnRecoveryMessagesLimit: 100,
      turnRecoveryPollInProgressMaxAttempts: 2,
      turnRecoveryPollInProgressDelayMs: 700,
      completionFetchMaxAttempts: 3,
      completionFetchDelayMs: 500,
      missingMessageRetryAfterMs: 30_000,
    })

    expect(runtime.createAuthHeaders({ "X-Test": "1" })).toEqual({
      Authorization: "Bearer test-key",
      "X-Test": "1",
    })
  })

  it("uses the latest runtime fetch getter when hydrating generated image cards", async () => {
    const repository = new MemoryAppRepository()
    let fetchCalls = 0
    let currentFetch = (async () =>
      new Response(
        JSON.stringify({
          asset_id: "asset_1",
          raw_url: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
          url: "https://cdn.test/renewed.jpg",
          url_expires_at: 1772411111,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )) as unknown as typeof fetch
    ;(currentFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}

    const runtime = createGatewayRecoveryRuntime({
      repository,
      getGatewayBaseUrl: () => "http://127.0.0.1:8787/v1",
      getRuntimeFetch: () => {
        fetchCalls += 1
        return currentFetch
      },
      getApiKey: () => "test-key",
      turnRecoveryMessagesLimit: 100,
      turnRecoveryPollInProgressMaxAttempts: 2,
      turnRecoveryPollInProgressDelayMs: 700,
      completionFetchMaxAttempts: 3,
      completionFetchDelayMs: 500,
      missingMessageRetryAfterMs: 30_000,
    })

    const hydrate = runtime.createGeneratedImageCardHydrator()
    const cards = [
      {
        id: "card_1",
        cardType: "image_card",
        type: "generated_image",
        url: "https://s3.bitiful.net/grok/assets/image/2026/03/expired.jpg?X-Amz-Signature=old",
        asset_id: "asset_1",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
        urlExpiresAt: "2020-03-02T00:00:00Z",
        image: {
          original: "https://s3.bitiful.net/grok/assets/image/2026/03/expired.jpg?X-Amz-Signature=old",
        },
      },
    ]
    await hydrate(cards)

    expect(fetchCalls).toBeGreaterThan(0)
    expect(cards[0]?.url).toBe("https://cdn.test/renewed.jpg")
  })
})
