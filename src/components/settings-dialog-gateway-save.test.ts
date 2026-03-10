import { describe, expect, it } from "bun:test"
import { getGatewaySaveButtonState } from "./settings-dialog-gateway-save"

describe("settings-dialog gateway save state", () => {
  it("returns saved and disabled when draft matches saved config", () => {
    expect(
      getGatewaySaveButtonState({
        current: { baseUrl: "http://127.0.0.1:8787/v1/responses", apiKey: "gw-123" },
        saved: { baseUrl: "http://127.0.0.1:8787/v1/responses", apiKey: "gw-123" },
        busy: false,
      })
    ).toEqual({
      hasChanges: false,
      disabled: true,
      label: "已保存",
    })
  })

  it("returns save when either field changes", () => {
    expect(
      getGatewaySaveButtonState({
        current: { baseUrl: "http://127.0.0.1:8788/v1/responses", apiKey: "gw-123" },
        saved: { baseUrl: "http://127.0.0.1:8787/v1/responses", apiKey: "gw-123" },
        busy: false,
      })
    ).toEqual({
      hasChanges: true,
      disabled: false,
      label: "保存",
    })
  })

  it("returns saving while persisting even when dirty", () => {
    expect(
      getGatewaySaveButtonState({
        current: { baseUrl: "http://127.0.0.1:8788/v1/responses", apiKey: "gw-456" },
        saved: { baseUrl: "http://127.0.0.1:8787/v1/responses", apiKey: "gw-123" },
        busy: true,
      })
    ).toEqual({
      hasChanges: true,
      disabled: true,
      label: "保存中...",
    })
  })
})
