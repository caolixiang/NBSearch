import { describe, expect, it } from "bun:test"
import {
  getVoiceEntryAriaLabel,
  getVoiceEntryBarHeights,
  getVoiceEntryConnectingBarMotion,
  VOICE_ENTRY_CONNECTING_DELAY_MS,
} from "./chat-input-voice-entry"

describe("chat-input voice entry", () => {
  it("returns the expected aria label for each state", () => {
    expect(getVoiceEntryAriaLabel("idle")).toBe("语音对话")
    expect(getVoiceEntryAriaLabel("connecting")).toBe("连接中……")
    expect(getVoiceEntryAriaLabel("active")).toBe("停止语音对话")
  })

  it("uses a distinct compact waveform while connecting", () => {
    expect(getVoiceEntryBarHeights("idle")).toHaveLength(6)
    expect(getVoiceEntryBarHeights("connecting")).toHaveLength(5)
    expect(getVoiceEntryBarHeights("connecting")).toEqual([
      "0.5rem",
      "0.72rem",
      "0.92rem",
      "0.62rem",
      "0.42rem",
    ])
    expect(getVoiceEntryBarHeights("connecting")).not.toEqual(getVoiceEntryBarHeights("idle"))
    expect(VOICE_ENTRY_CONNECTING_DELAY_MS).toBe(420)
  })

  it("provides per-bar motion config for the connecting waveform", () => {
    expect(getVoiceEntryConnectingBarMotion(0)).toEqual({
      delayMs: 0,
      durationMs: 780,
      minScale: 0.56,
      maxScale: 1.22,
    })
    expect(getVoiceEntryConnectingBarMotion(9)).toEqual({
      delayMs: 360,
      durationMs: 760,
      minScale: 0.54,
      maxScale: 1.34,
    })
  })
})
