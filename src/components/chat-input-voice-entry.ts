export type VoiceEntryState = "idle" | "connecting" | "active"

export const VOICE_ENTRY_CONNECTING_DELAY_MS = 420

interface VoiceEntryConnectingBarMotion {
  readonly delayMs: number
  readonly durationMs: number
  readonly minScale: number
  readonly maxScale: number
}

interface VoiceEntryIdleBarMotion {
  readonly delayMs: number
  readonly durationMs: number
  readonly peakScale: number
}

const IDLE_BAR_HEIGHTS = ["0.4rem", "0.8rem", "1.2rem", "0.7rem", "1rem", "0.4rem"] as const
const CONNECTING_BAR_HEIGHTS = [
  "0.5rem",
  "0.72rem",
  "0.92rem",
  "0.62rem",
  "0.42rem",
] as const

const CONNECTING_BAR_MOTION: readonly VoiceEntryConnectingBarMotion[] = [
  { delayMs: 0, durationMs: 780, minScale: 0.56, maxScale: 1.22 },
  { delayMs: 90, durationMs: 900, minScale: 0.52, maxScale: 1.14 },
  { delayMs: 180, durationMs: 840, minScale: 0.48, maxScale: 1.28 },
  { delayMs: 270, durationMs: 920, minScale: 0.5, maxScale: 1.18 },
  { delayMs: 360, durationMs: 760, minScale: 0.54, maxScale: 1.34 },
] as const

const IDLE_BAR_HOVER_MOTION: readonly VoiceEntryIdleBarMotion[] = [
  { delayMs: 0, durationMs: 340, peakScale: 1.08 },
  { delayMs: 30, durationMs: 360, peakScale: 1.14 },
  { delayMs: 60, durationMs: 380, peakScale: 1.18 },
  { delayMs: 90, durationMs: 360, peakScale: 1.12 },
  { delayMs: 120, durationMs: 380, peakScale: 1.16 },
  { delayMs: 150, durationMs: 340, peakScale: 1.08 },
] as const

export function getVoiceEntryBarHeights(state: VoiceEntryState): readonly string[] {
  return state === "connecting" ? CONNECTING_BAR_HEIGHTS : IDLE_BAR_HEIGHTS
}

export function getVoiceEntryConnectingBarMotion(index: number): VoiceEntryConnectingBarMotion {
  return CONNECTING_BAR_MOTION[index] ?? CONNECTING_BAR_MOTION[CONNECTING_BAR_MOTION.length - 1]
}

export function getVoiceEntryIdleBarMotion(index: number): VoiceEntryIdleBarMotion {
  return IDLE_BAR_HOVER_MOTION[index] ?? IDLE_BAR_HOVER_MOTION[IDLE_BAR_HOVER_MOTION.length - 1]
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
