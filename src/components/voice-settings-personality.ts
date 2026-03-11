export function shouldShowCustomPromptEditor(personalityId: string): boolean {
  return personalityId === "custom"
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
    personality: normalizedPersonalityId || "assistant",
    instructions: "",
    isRawInstructions: false,
  }
}
