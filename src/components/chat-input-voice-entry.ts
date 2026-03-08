export type VoiceEntryState = "idle" | "connecting" | "active"

export const VOICE_ENTRY_CONNECTING_DELAY_MS = 420

const IDLE_BAR_HEIGHTS = ["0.4rem", "0.8rem", "1.2rem", "0.7rem", "1rem", "0.4rem"] as const
const CONNECTING_BAR_HEIGHTS = [
  "0.749rem",
  "1.10696rem",
  "1.19582rem",
  "1.00402rem",
  "0.59398rem",
  "0.29407rem",
] as const

export function getVoiceEntryBarHeights(state: VoiceEntryState): readonly string[] {
  return state === "connecting" ? CONNECTING_BAR_HEIGHTS : IDLE_BAR_HEIGHTS
}

export function getVoiceEntryAriaLabel(state: VoiceEntryState): string {
  if (state === "connecting") {
    return "连接中……"
  }
  if (state === "active") {
    return "停止语音对话"
  }
  return "语音对话"
}
