import { describe, expect, it } from "bun:test"
import {
  VOICE_SPEED_STEPS,
  formatVoiceSpeed,
  normalizeVoiceSpeed,
} from "./voice-settings-speed"

describe("voice-settings-speed", () => {
  it("builds 0.1x steps from 0.5x to 2.0x", () => {
    expect(VOICE_SPEED_STEPS).toHaveLength(16)
    expect(VOICE_SPEED_STEPS[0]).toBe(0.5)
    expect(VOICE_SPEED_STEPS[6]).toBe(1.1)
    expect(VOICE_SPEED_STEPS.at(-1)).toBe(2)
  })

  it("normalizes arbitrary values onto the nearest 0.1x step", () => {
    expect(normalizeVoiceSpeed(1.14)).toBe(1.1)
    expect(normalizeVoiceSpeed(1.16)).toBe(1.2)
  })

  it("clamps values to the supported range", () => {
    expect(normalizeVoiceSpeed(0.1)).toBe(0.5)
    expect(normalizeVoiceSpeed(3)).toBe(2)
  })

  it("formats speeds with a single decimal place", () => {
    expect(formatVoiceSpeed(1)).toBe("1.0")
    expect(formatVoiceSpeed(1.08)).toBe("1.1")
  })
})
