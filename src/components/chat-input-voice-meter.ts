const VOICE_METER_BASE_HEIGHTS = [0.2, 0.3, 0.42, 0.32, 0.22] as const
const VOICE_METER_RANGES = [0.26, 0.42, 0.56, 0.44, 0.32] as const

export function normalizeVoiceMeterLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 0
  }
  const clamped = Math.max(0, Math.min(1, level))
  if (clamped < 0.03) {
    return 0
  }
  return Math.min(1, Math.pow(clamped, 0.78) * 1.35)
}

export function getVoiceMeterBarHeights(level: number): readonly string[] {
  const normalizedLevel = normalizeVoiceMeterLevel(level)
  return VOICE_METER_BASE_HEIGHTS.map((base, index) => {
    const nextHeight = base + normalizedLevel * VOICE_METER_RANGES[index]
    return `${nextHeight.toFixed(3)}rem`
  })
}
