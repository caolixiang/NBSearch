export type VoiceAssistantDeltaSource = "audio" | "text" | "other"

export interface VoiceAssistantDeltaTracker {
  responseId: string
  source: VoiceAssistantDeltaSource
}

export function classifyVoiceAssistantDeltaSource(source?: string): VoiceAssistantDeltaSource {
  const normalized = (source || "").trim()
  if (normalized.startsWith("response.audio_transcript")) {
    return "audio"
  }
  if (normalized.startsWith("response.text")) {
    return "text"
  }
  return "other"
}

export function resolveVoiceAssistantDeltaTracker(
  current: VoiceAssistantDeltaTracker | null,
  input: {
    responseId?: string
    source?: string
  }
): {
  accept: boolean
  next: VoiceAssistantDeltaTracker
} {
  const next: VoiceAssistantDeltaTracker = {
    responseId: (input.responseId || "").trim(),
    source: classifyVoiceAssistantDeltaSource(input.source),
  }

  if (!current) {
    return {
      accept: true,
      next,
    }
  }

  const currentResponseId = current.responseId.trim()
  const nextResponseId = next.responseId.trim()
  const sameResponseId =
    !currentResponseId || !nextResponseId || currentResponseId === nextResponseId

  if (!sameResponseId) {
    return {
      accept: true,
      next,
    }
  }

  if (current.source === next.source) {
    return {
      accept: true,
      next: current,
    }
  }

  return {
    accept: false,
    next: current,
  }
}
