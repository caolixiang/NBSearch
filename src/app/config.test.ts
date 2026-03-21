import { describe, expect, it } from "bun:test"
import { loadAppConfig } from "./config"

describe("loadAppConfig env defaults", () => {
  it("leaves OpenAI base URL empty by default while keeping the default model", async () => {
    const config = await loadAppConfig()

    expect(config.openaiApiBaseUrl).toBe("")
    expect(config.openaiTranslationModel).toBe("gpt-5.4-mini")
    expect(config.openaiApiKey).toBe("")
    expect(config.polymarketSubscriptionEnabled).toBe(false)
    expect(config.kalshiSubscriptionEnabled).toBe(false)
    expect(config.feedCustomAccounts).toEqual([])
  })
})
