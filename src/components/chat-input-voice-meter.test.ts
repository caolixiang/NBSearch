import { describe, expect, it } from "bun:test"
import { getVoiceMeterBarHeights, normalizeVoiceMeterLevel } from "./chat-input-voice-meter"

describe("chat-input voice meter", () => {
  it("normalizes invalid or tiny mic levels to zero", () => {
    expect(normalizeVoiceMeterLevel(Number.NaN)).toBe(0)
    expect(normalizeVoiceMeterLevel(-1)).toBe(0)
    expect(normalizeVoiceMeterLevel(0.02)).toBe(0)
  })

  it("boosts valid mic levels into a visible range", () => {
    expect(normalizeVoiceMeterLevel(0.2)).toBeGreaterThan(0.3)
    expect(normalizeVoiceMeterLevel(1)).toBe(1)
  })

  it("maps mic levels to five compact bar heights", () => {
    expect(getVoiceMeterBarHeights(0)).toEqual([
      "0.200rem",
      "0.300rem",
      "0.420rem",
      "0.320rem",
      "0.220rem",
    ])
    expect(getVoiceMeterBarHeights(1)).toEqual([
      "0.460rem",
      "0.720rem",
      "0.980rem",
      "0.760rem",
      "0.540rem",
    ])
  })
})
