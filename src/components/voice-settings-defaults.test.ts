import { describe, expect, it } from "bun:test"
import {
  DEFAULT_VOICE_OPTION_ID,
  DEFAULT_VOICE_PERSONALITY_ID,
  getVoiceOptionLabel,
  resolveVoiceTransportId,
} from "./voice-settings-sheet"

describe("voice-settings defaults", () => {
  it("defaults to Ara voice and Assistant personality", () => {
    expect(DEFAULT_VOICE_OPTION_ID).toBe("ara")
    expect(DEFAULT_VOICE_PERSONALITY_ID).toBe("assistant")
  })

  it("falls back to Ara label for unknown voice ids", () => {
    expect(getVoiceOptionLabel("unknown")).toBe("Ara")
  })

  it("maps strict voice ids to the observed transport strings", () => {
    expect(resolveVoiceTransportId("sal")).toBe("xai_sal")
    expect(resolveVoiceTransportId("rex")).toBe("xai_rex")
    expect(resolveVoiceTransportId("gork")).toBe("Gork")
  })

  it("resolves canonical transport ids back to UI labels", () => {
    expect(getVoiceOptionLabel("xai_sal")).toBe("Sal")
    expect(getVoiceOptionLabel("xai_rex")).toBe("Rex")
    expect(getVoiceOptionLabel("Gork")).toBe("Gork")
  })
})
