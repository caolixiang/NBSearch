import { describe, expect, it } from "bun:test"
import { resolveVoiceConnectionErrorMessage, shouldRenderVoicePanel } from "./chat-input-voice-state"

describe("chat-input voice state", () => {
  it("keeps the voice panel visible while connecting or active", () => {
    expect(shouldRenderVoicePanel("idle")).toBe(false)
    expect(shouldRenderVoicePanel("connecting")).toBe(true)
    expect(shouldRenderVoicePanel("active")).toBe(true)
  })

  it("maps microphone permission failures to a readable message", () => {
    expect(resolveVoiceConnectionErrorMessage(new Error("NotAllowedError: Permission denied"))).toBe(
      "未获得麦克风权限，请在系统设置中允许 NBSearch 访问麦克风后重试。"
    )
  })

  it("maps missing microphone failures to a readable message", () => {
    expect(resolveVoiceConnectionErrorMessage(new Error("NotFoundError: Requested device not found"))).toBe(
      "未检测到可用麦克风，请检查设备连接后重试。"
    )
  })

  it("falls back to a generic message for empty errors", () => {
    expect(resolveVoiceConnectionErrorMessage("")).toBe("语音连接失败，请重试。")
  })
})
