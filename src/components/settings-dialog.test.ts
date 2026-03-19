import { describe, expect, it } from "bun:test"
import { resolveSettingsDialogTab } from "./settings-dialog"

describe("settings-dialog tab routing", () => {
  it("falls back to gateway for empty or unknown requested tabs", () => {
    expect(resolveSettingsDialogTab()).toBe("gateway")
    expect(resolveSettingsDialogTab(null)).toBe("gateway")
    expect(resolveSettingsDialogTab("unknown")).toBe("gateway")
  })

  it("accepts supported requested tabs", () => {
    expect(resolveSettingsDialogTab("subscriptions")).toBe("subscriptions")
    expect(resolveSettingsDialogTab("openai")).toBe("openai")
  })
})
