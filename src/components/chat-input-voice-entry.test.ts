import { describe, expect, it } from "bun:test"
import { getVoiceEntryAriaLabel, getVoiceEntryBarHeights, VOICE_ENTRY_CONNECTING_DELAY_MS } from "./chat-input-voice-entry"

describe("chat-input voice entry", () => {
  it("returns the expected aria label for each state", () => {
    expect(getVoiceEntryAriaLabel("idle")).toBe("语音对话")
    expect(getVoiceEntryAriaLabel("connecting")).toBe("连接中……")
    expect(getVoiceEntryAriaLabel("active")).toBe("停止语音对话")
  })

  it("uses a distinct 6-bar waveform while connecting", () => {
    expect(getVoiceEntryBarHeights("idle")).toHaveLength(6)
    expect(getVoiceEntryBarHeights("connecting")).toEqual([
      "1.19988rem",
      "1.06865rem",
      "0.68365rem",
      "0.3341rem",
      "0.25rem",
      "0.25rem",
    ])
    expect(getVoiceEntryBarHeights("connecting")).not.toEqual(getVoiceEntryBarHeights("idle"))
    expect(VOICE_ENTRY_CONNECTING_DELAY_MS).toBe(420)
  })
})
