import { describe, expect, it } from "bun:test"
import { ProviderRouter } from "./provider-router"

const router = new ProviderRouter({
  apiBaseUrl: "http://localhost:8787",
  apiKey: "test-key",
  defaultModel: "grok-4.1-fast",
  voiceEnabled: true,
  anthropicApiKey: "test-anthropic",
})

describe("ProviderRouter", () => {
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
