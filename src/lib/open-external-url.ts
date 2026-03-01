import { hasTauriRuntime } from "@/app/runtime-info"

function normalizeExternalHttpUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return ""
    }
    return parsed.href
  } catch {
    return ""
  }
}

export async function openExternalUrl(input: string): Promise<boolean> {
  const href = normalizeExternalHttpUrl(input)
  if (!href) {
    return false
  }

  if (hasTauriRuntime()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(href)
      return true
    } catch {
      // Fall through to browser open fallback.
    }
  }

  if (typeof window !== "undefined") {
    window.open(href, "_blank", "noopener,noreferrer")
    return true
  }

  return false
}
