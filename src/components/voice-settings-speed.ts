export const VOICE_SPEED_MIN = 0.5
export const VOICE_SPEED_MAX = 2
export const VOICE_SPEED_STEP = 0.1

const SPEED_STEP_COUNT = Math.round((VOICE_SPEED_MAX - VOICE_SPEED_MIN) / VOICE_SPEED_STEP)

export const VOICE_SPEED_STEPS = Array.from({ length: SPEED_STEP_COUNT + 1 }, (_, index) =>
  Number((VOICE_SPEED_MIN + index * VOICE_SPEED_STEP).toFixed(1))
)

export function normalizeVoiceSpeed(value: number): number {
  const clamped = Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, value))
  const offsetSteps = Math.round((clamped - VOICE_SPEED_MIN) / VOICE_SPEED_STEP)
  return Number((VOICE_SPEED_MIN + offsetSteps * VOICE_SPEED_STEP).toFixed(1))
}

export function formatVoiceSpeed(value: number): string {
  return normalizeVoiceSpeed(value).toFixed(1)
}
