export type VoiceEntryState = "idle" | "connecting" | "active"

export const VOICE_ENTRY_CONNECTING_DELAY_MS = 420

const IDLE_BAR_HEIGHTS = ["0.4rem", "0.8rem", "1.2rem", "0.7rem", "1rem", "0.4rem"] as const
const CONNECTING_BAR_HEIGHTS = [
  "1.19988rem",
  "1.06865rem",
  "0.68365rem",
  "0.3341rem",
  "0.25rem",
  "0.25rem",
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
