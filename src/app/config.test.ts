import { describe, expect, it } from "bun:test"
import { loadAppConfig } from "./config"

describe("loadAppConfig env defaults", () => {
  it("provides default OpenAI settings for feed translation", async () => {
    const config = await loadAppConfig()

    expect(config.openaiApiBaseUrl).toBe("https://cpabak.zeabur.app/v1")
    expect(config.openaiTranslationModel).toBe("gpt-5.4-mini")
    expect(config.openaiApiKey).toBe("")
  })
})
