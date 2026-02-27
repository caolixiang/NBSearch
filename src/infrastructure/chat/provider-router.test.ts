import { describe, expect, it } from "bun:test"
import {
  GATEWAY_SESSION_ID_METADATA_KEY,
  injectGatewaySessionId,
  normalizeGatewayBaseUrl,
  ProviderRouter,
} from "./provider-router"

const router = new ProviderRouter({
  apiBaseUrl: "http://localhost:8787",
  apiKey: "test-key",
  defaultModel: "grok-4.1-fast",
  voiceEnabled: true,
  anthropicApiKey: "test-anthropic",
})

describe("ProviderRouter", () => {
  it("normalizes bare host to /v1", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/v1")
  })

  it("keeps /v1 as is", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8787/v1")).toBe("http://127.0.0.1:8787/v1")
  })

  it("accepts full responses endpoint", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8787/v1/responses")).toBe("http://127.0.0.1:8787/v1")
  })

  it("injects session_id from metadata", () => {
    const raw = JSON.stringify({
      model: "grok-4.1-fast",
      input: "hello",
      metadata: {
        [GATEWAY_SESSION_ID_METADATA_KEY]: "sess_123",
        tag: "x",
      },
    })
    const payload = JSON.parse(injectGatewaySessionId(raw)) as {
      session_id?: string
      metadata?: Record<string, unknown>
    }
    expect(payload.session_id).toBe("sess_123")
    expect(payload.metadata).toEqual({ tag: "x" })
  })

  it("keeps existing session_id untouched", () => {
    const raw = JSON.stringify({
      model: "grok-4.1-fast",
      input: "hello",
      session_id: "sess_existing",
      metadata: {
        [GATEWAY_SESSION_ID_METADATA_KEY]: "sess_new",
      },
    })
    const payload = JSON.parse(injectGatewaySessionId(raw)) as { session_id?: string }
    expect(payload.session_id).toBe("sess_existing")
  })

  it("routes anthropic/* models to anthropic provider", () => {
    const resolved = router.resolve("anthropic/claude-sonnet-4-5")
    expect(resolved.provider).toBe("anthropic")
    expect(resolved.modelId).toBe("claude-sonnet-4-5")
  })

  it("routes claude* models to anthropic provider", () => {
    const resolved = router.resolve("claude-opus-4-1")
    expect(resolved.provider).toBe("anthropic")
    expect(resolved.modelId).toBe("claude-opus-4-1")
  })

  it("routes non-claude models to gateway provider", () => {
    const resolved = router.resolve("openai/gpt-5-mini")
    expect(resolved.provider).toBe("gateway")
    expect(resolved.modelId).toBe("openai/gpt-5-mini")
  })
})
