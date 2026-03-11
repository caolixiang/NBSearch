interface VoiceMeterBarMotion {
  readonly delayMs: number
  readonly durationMs: number
  readonly peakScale: number
}

const VOICE_METER_IDLE_HEIGHTS = ["0.18rem", "0.2rem", "0.18rem", "0.16rem", "0.14rem"] as const
const VOICE_METER_SPEAKING_HEIGHTS = ["0.34rem", "0.41rem", "0.45rem", "0.31rem", "0.22rem"] as const
const VOICE_METER_SPEAKING_MOTION: readonly VoiceMeterBarMotion[] = [
  { delayMs: 0, durationMs: 760, peakScale: 1.18 },
  { delayMs: 90, durationMs: 840, peakScale: 1.12 },
  { delayMs: 180, durationMs: 720, peakScale: 1.2 },
  { delayMs: 270, durationMs: 860, peakScale: 1.14 },
  { delayMs: 360, durationMs: 740, peakScale: 1.22 },
] as const

export function isVoiceMeterSpeaking(level: number): boolean {
  if (!Number.isFinite(level)) {
    return false
  }
  return level >= 0.08
}

export function getVoiceMeterBarHeights(speaking: boolean): readonly string[] {
  return speaking ? VOICE_METER_SPEAKING_HEIGHTS : VOICE_METER_IDLE_HEIGHTS
}

export function getVoiceMeterBarMotion(index: number): VoiceMeterBarMotion {
  return VOICE_METER_SPEAKING_MOTION[index] ?? VOICE_METER_SPEAKING_MOTION[VOICE_METER_SPEAKING_MOTION.length - 1]
}
