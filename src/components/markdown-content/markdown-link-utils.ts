export function isLikelyImageUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:[?#].*)?$/i.test(text)
}

export function isLikelyHttpUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^https?:\/\/[^\s<>"']+$/i.test(text)
}

export function isLikelyDataImageUrl(value: string): boolean {
  const text = value.trim()
  if (!text) {
    return false
  }
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(text)
}

export function isBlockedImagePlaceholder(value: string): boolean {
  const text = value
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, "")
  if (!text) {
    return false
  }
  return /^\[?\s*image blocked\s*[:：]/i.test(text)
}

export function unwrapMarkdownUrl(value: string): string {
  const text = value.trim()
  if (text.startsWith("<") && text.endsWith(">") && text.length > 2) {
    return text.slice(1, -1).trim()
  }
  return text
}

export function normalizeAbsoluteHttpUrl(value: string): string {
  const raw = unwrapMarkdownUrl(value)
  if (!raw) {
    return ""
  }

  const candidates = [raw]
  const encoded = encodeURI(raw)
  if (encoded !== raw) {
    candidates.push(encoded)
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href
      }
    } catch {
      continue
    }
  }
  return ""
}

export function normalizeCardImageUrl(value: string): string {
  const text = unwrapMarkdownUrl(value)
  if (!text || isBlockedImagePlaceholder(text)) {
    return ""
  }
  if (isLikelyDataImageUrl(text)) {
    return text
  }
  return normalizeAbsoluteHttpUrl(text)
}

export function normalizeCardTargetUrl(value: string): string {
  const text = unwrapMarkdownUrl(value)
  if (!text || isBlockedImagePlaceholder(text)) {
    return ""
  }
  return normalizeAbsoluteHttpUrl(text)
}

export function stripFallbackSuffix(value: string): string {
  const marker = "#fallback="
  const index = value.indexOf(marker)
  if (index < 0) {
    return value
  }
  return value.slice(0, index)
}

export function buildUrlMatchKeys(value: string): string[] {
  const normalized = normalizeAbsoluteHttpUrl(value)
  if (!normalized) {
    return []
  }

  const keys = new Set<string>([normalized])
  try {
    const parsed = new URL(normalized)
    const host = parsed.host.toLowerCase()
    const protocolAgnostic = `//${host}${parsed.pathname}${parsed.search}`
    keys.add(protocolAgnostic)
  } catch {
    // Ignore URL parsing errors; normalized key is already present.
  }
  return Array.from(keys)
}

export function extractFirstImageUrlFromText(value: string): string {
  const match = /https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?[<>\s"]*)?/i.exec(value)
  return match?.[0] || ""
}

export function normalizeRenderableImageUrl(value: string): string {
  const text = unwrapMarkdownUrl(value)
  if (!text) {
    return ""
  }
  return normalizeAbsoluteHttpUrl(text)
}

export function toMarkdownImageLine(url: string): string {
  return `![Generated Image](<${normalizeRenderableImageUrl(url)}>)`
}

export function extractImageUrlFromJsonLikeLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) {
    return ""
  }
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return ""
  }

  const imageUrlMatch = /["']image_url["']\s*:\s*["']([^"']+)["']/i.exec(trimmed)
  if (imageUrlMatch?.[1]) {
    return normalizeRenderableImageUrl(imageUrlMatch[1])
  }

  const urlMatch = /["']url["']\s*:\s*["']([^"']+)["']/i.exec(trimmed)
  if (urlMatch?.[1] && isLikelyImageUrl(urlMatch[1])) {
    return normalizeRenderableImageUrl(urlMatch[1])
  }

  return ""
}

export function isLikelyInternalRelayJson(value: Record<string, unknown>): boolean {
  const hasRoutingKey =
    typeof value.to === "string" ||
    typeof value.from === "string" ||
    typeof value.sender === "string" ||
    typeof value.receiver === "string" ||
    typeof value.recipient === "string" ||
    typeof value.rolloutId === "string" ||
    typeof value.rollout_id === "string"

  if (!hasRoutingKey) {
    return false
  }

  return typeof value.message === "string" || typeof value.content === "string"
}

export function isStandaloneImageMarkdown(value: string): boolean {
  return (
    /^\s*!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value) ||
    /^\s*\[!\[(?:\\.|[^\]])*]\((?:<[^>]+>|[^)]+)\)]\((?:<[^>]+>|[^)]+)\)\s*$/.test(value)
  )
}

export function hasMarkdownImage(value: string): boolean {
  return /\[!\[(?:\\.|[^\]])*]\((?:<[^>\n]+>|[^)\n]+)\)\]\((?:<[^>\n]+>|[^)\n]+)\)|!\[(?:\\.|[^\]])*]\((?:<[^>\n]+>|[^)\n]+)\)/.test(value)
}
