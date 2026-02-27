import type { AppConfig } from "./contracts"

function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (!input) {
    return fallback
  }
  const value = input.trim().toLowerCase()
  if (value === "true") {
    return true
  }
  if (value === "false") {
    return false
  }
  return fallback
}

export function loadAppConfig(): AppConfig {
  return {
    apiBaseUrl: import.meta.env.VITE_APP_API_BASE_URL?.trim() || "http://localhost:8787",
    apiKey: import.meta.env.VITE_APP_API_KEY?.trim() || "",
    defaultModel: import.meta.env.VITE_APP_DEFAULT_MODEL?.trim() || "grok-4.1-fast",
    voiceEnabled: parseBool(import.meta.env.VITE_APP_VOICE_ENABLED, true),
    anthropicApiKey: import.meta.env.VITE_APP_ANTHROPIC_API_KEY?.trim() || undefined,
    anthropicBaseUrl: import.meta.env.VITE_APP_ANTHROPIC_BASE_URL?.trim() || undefined,
  }
}
