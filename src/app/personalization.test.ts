import { describe, expect, it } from "bun:test"
import { DEFAULT_APP_TIMEZONE, normalizeAppTimezone, resolveAppTimezoneOptions } from "./personalization"

describe("app personalization", () => {
  it("defaults timezone to Asia/Shanghai when value is empty", () => {
    expect(DEFAULT_APP_TIMEZONE).toBe("Asia/Shanghai")
    expect(normalizeAppTimezone("")).toBe("Asia/Shanghai")
    expect(normalizeAppTimezone(undefined)).toBe("Asia/Shanghai")
  })

  it("keeps custom timezone values and exposes them in options", () => {
    const options = resolveAppTimezoneOptions("Pacific/Auckland")
    expect(options[0]).toEqual({
      value: "Pacific/Auckland",
      label: "Pacific/Auckland（自定义）",
    })
  })
})
