import { describe, expect, it } from "bun:test"
import {
  DEFAULT_VOICE_OPTION_ID,
  DEFAULT_VOICE_PERSONALITY_ID,
  getVoiceOptionLabel,
} from "./voice-settings-sheet"

describe("voice-settings defaults", () => {
  it("defaults to Ara voice and Assistant personality", () => {
    expect(DEFAULT_VOICE_OPTION_ID).toBe("ara")
    expect(DEFAULT_VOICE_PERSONALITY_ID).toBe("assistant")
  })

  it("falls back to Ara label for unknown voice ids", () => {
    expect(getVoiceOptionLabel("unknown")).toBe("Ara")
  })
})
