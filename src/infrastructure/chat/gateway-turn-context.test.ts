import { describe, expect, it } from "bun:test"
import {
  buildConversationLocaleInstructions,
  buildTurnTimeContextSuffix,
  resolveConversationLocation,
} from "./gateway-turn-context"

describe("gateway turn context", () => {
  it("maps supported timezones to readable locations", () => {
    expect(resolveConversationLocation("Asia/Shanghai")).toBe("Shanghai, China")
    expect(resolveConversationLocation("America/New_York")).toBe("New York, New York, United States")
  })

  it("falls back to the timezone value for custom locations", () => {
    expect(resolveConversationLocation("Pacific/Honolulu")).toBe("Pacific/Honolulu")
  })

  it("builds first-turn locale instructions from the timezone", () => {
    const xml = buildConversationLocaleInstructions("Asia/Shanghai")

    expect(xml).toContain("<timezone>Asia/Shanghai</timezone>")
    expect(xml).toContain("<location>Shanghai, China</location>")
    expect(xml).toContain("the last 24 hours")
  })

  it("builds a deterministic turn-time suffix in the configured timezone", () => {
    const suffix = buildTurnTimeContextSuffix("Pacific/Honolulu", new Date("2026-03-10T03:44:44Z"))

    expect(suffix).toBe(
      "[Authoritative current local time for this turn only: 2026-03-09 17:44:44 Pacific/Honolulu (UTC-10:00). Ignore any earlier turn times and use this time as the reference for this turn.]"
    )
  })
})
