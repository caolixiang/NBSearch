const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v"])

function resolveMediaUrl(url: string): URL | null {
  const trimmed = url.trim()
  if (!trimmed) {
    return null
  }
  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

function resolvePathExtension(url: URL): string {
  const pathname = url.pathname.toLowerCase()
  const lastSegment = pathname.split("/").pop() || ""
  const dotIndex = lastSegment.lastIndexOf(".")
  if (dotIndex >= 0 && dotIndex < lastSegment.length - 1) {
    return lastSegment.slice(dotIndex + 1)
  }
  const format = url.searchParams.get("format") || ""
  return format.trim().toLowerCase()
}

export function isFeedVideoUrl(value: string): boolean {
  const url = resolveMediaUrl(value)
  if (!url) {
    return false
  }
  return VIDEO_EXTENSIONS.has(resolvePathExtension(url))
}

export function getRenderableFeedImageUrls(mediaUrls: string[]): string[] {
  return mediaUrls
    .map((url) => url.trim())
    .filter((url) => url.length > 0 && !isFeedVideoUrl(url))
}
