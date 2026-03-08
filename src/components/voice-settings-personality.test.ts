import { describe, expect, it } from "bun:test"
import { shouldShowCustomPromptEditor } from "./voice-settings-personality"

describe("voice-settings-personality", () => {
  it("shows the custom prompt editor only for the custom personality", () => {
    expect(shouldShowCustomPromptEditor("custom")).toBe(true)
    expect(shouldShowCustomPromptEditor("assistant")).toBe(false)
    expect(shouldShowCustomPromptEditor("therapist")).toBe(false)
  })
})
