export function shouldShowCustomPromptEditor(personalityId: string): boolean {
  return personalityId === "custom"
}

const PERSONALITY_TRANSPORT_ID_ALIASES: Record<string, string> = {
  assistant: "assistant",
  therapist: "therapist",
  storyteller: "storyteller",
  kids_story: "kids-stories",
  "kids-stories": "kids-stories",
  kids_trivia: "kids-trivia",
  "kids-trivia": "kids-trivia",
  meditation: "meditation",
  doc: "doc",
  unhinged: "unhinged",
  sexy: "sexy",
  motivation: "motivation",
  conspiracy: "conspiracy",
  romantic: "romantic",
  argumentative: "argumentative",
}

export function resolveVoiceTransportPersonalityId(personalityId: string): string {
  const trimmedPersonalityId = personalityId.trim()
  if (!trimmedPersonalityId) {
    return "assistant"
  }

  return PERSONALITY_TRANSPORT_ID_ALIASES[trimmedPersonalityId.toLowerCase()] ?? trimmedPersonalityId
}

export function resolveVoicePersonalityPayload(personalityId: string, customPrompt: string): {
  personality: string | null
  instructions: string
  isRawInstructions: boolean
} {
  const normalizedPersonalityId = personalityId.trim()
  const normalizedPrompt = customPrompt.trim()

  if (normalizedPersonalityId === "custom" && normalizedPrompt) {
    return {
      personality: null,
      instructions: normalizedPrompt,
      isRawInstructions: true,
    }
  }

  return {
    personality: resolveVoiceTransportPersonalityId(normalizedPersonalityId),
    instructions: "",
    isRawInstructions: false,
  }
}
