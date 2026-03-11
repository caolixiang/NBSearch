import { describe, expect, it } from "bun:test"
import { getVoiceMeterBarHeights, getVoiceMeterBarMotion, isVoiceMeterSpeaking } from "./chat-input-voice-meter"

describe("chat-input voice meter", () => {
  it("treats low or invalid mic levels as silence", () => {
    expect(isVoiceMeterSpeaking(Number.NaN)).toBe(false)
    expect(isVoiceMeterSpeaking(0.02)).toBe(false)
    expect(isVoiceMeterSpeaking(0.08)).toBe(true)
  })

  it("returns static low bars when silent and fixed taller bars when speaking", () => {
    expect(getVoiceMeterBarHeights(false)).toEqual([
      "0.18rem",
      "0.2rem",
      "0.18rem",
      "0.16rem",
      "0.14rem",
    ])
    expect(getVoiceMeterBarHeights(true)).toEqual([
      "0.34rem",
      "0.41rem",
      "0.45rem",
      "0.31rem",
      "0.22rem",
    ])
  })

  it("provides staggered motion config for speaking animation", () => {
    expect(getVoiceMeterBarMotion(0)).toEqual({
      delayMs: 0,
      durationMs: 760,
      peakScale: 1.18,
    })
    expect(getVoiceMeterBarMotion(9)).toEqual({
      delayMs: 360,
      durationMs: 740,
      peakScale: 1.22,
    })
  })
})
