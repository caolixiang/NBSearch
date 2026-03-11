import { describe, expect, it } from "bun:test"
import { resolveVoicePersonalityPayload, shouldShowCustomPromptEditor } from "./voice-settings-personality"

describe("voice-settings-personality", () => {
  it("shows the custom prompt editor only for the custom personality", () => {
    expect(shouldShowCustomPromptEditor("custom")).toBe(true)
    expect(shouldShowCustomPromptEditor("assistant")).toBe(false)
    expect(shouldShowCustomPromptEditor("therapist")).toBe(false)
  })

  it("maps custom personality to instructions payload", () => {
    expect(resolveVoicePersonalityPayload("custom", "  be warm and concise  ")).toEqual({
      personality: null,
      instructions: "be warm and concise",
      isRawInstructions: true,
    })
  })

  it("maps preset personality to a plain personality payload", () => {
    expect(resolveVoicePersonalityPayload("assistant", "ignored")).toEqual({
      personality: "assistant",
      instructions: "",
      isRawInstructions: false,
    })
  })
})
