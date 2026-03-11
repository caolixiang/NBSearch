import type { VoiceEntryState } from "./chat-input-voice-entry"

export function shouldRenderVoicePanel(state: VoiceEntryState): boolean {
  return state === "active" || state === "connecting"
}

export function resolveVoiceConnectionErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const normalized = raw.trim()
  const lower = normalized.toLowerCase()

  if (
    lower.includes("notallowederror") ||
    lower.includes("permission denied") ||
    lower.includes("permission dismissed") ||
    lower.includes("microphone permission")
  ) {
    return "未获得麦克风权限，请在系统设置中允许 NBSearch 访问麦克风后重试。"
  }

  if (
    lower.includes("notfounderror") ||
    lower.includes("found no audio") ||
    lower.includes("no audio device") ||
    lower.includes("device not found")
  ) {
    return "未检测到可用麦克风，请检查设备连接后重试。"
  }

  if (lower.includes("aborterror")) {
    return "语音连接已中断，请重试。"
  }

  if (normalized === "voice service unavailable") {
    return "语音服务不可用，请检查网关配置后重试。"
  }

  if (normalized === "voice conversation is required") {
    return "语音会话初始化失败，请重试。"
  }

  if (!normalized || normalized === "voice_error") {
    return "语音连接失败，请重试。"
  }

  return `语音连接失败：${normalized}`
}
