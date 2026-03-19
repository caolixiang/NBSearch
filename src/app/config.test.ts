import { describe, expect, it } from "bun:test"
import { loadAppConfig } from "./config"

describe("loadAppConfig env defaults", () => {
  it("provides default llm gateway settings for feed translation", async () => {
    const config = await loadAppConfig()

    expect(config.llmApiBaseUrl).toBe("https://cpabak.zeabur.app/v1")
    expect(config.llmTranslationModel).toBe("gpt-5.4-mini")
    expect(config.llmApiKey).toBe("")
  })
})
