const POSTS_HEADING_PATTERN = /^##\s+Polymarket(?:’|')s posts\s*$/i
const PROFILE_LINE_PATTERN =
  /^\[!\[[^\]]*profile picture[^\]]*\]\(https:\/\/pbs\.twimg\.com\/profile_images\/[^)]+\)\]\(https:\/\/x\.com\/Polymarket(?:\/photo)?\)$/i
const STATUS_URL_PATTERN = /https:\/\/x\.com\/Polymarket\/status\/(\d+)/i
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g

export interface ParsedPolymarketTimelineItem {
  title: string
  contentMarkdown: string
  mediaUrls: string[]
  canonicalUrl: string
  publishedAt: number | null
}

function extractReaderMarkdownBody(raw: string): string {
  const marker = "Markdown Content:"
  const index = raw.indexOf(marker)
  if (index < 0) {
    return raw.trim()
  }
  return raw.slice(index + marker.length).trim()
}

function isProfileLine(line: string): boolean {
  return PROFILE_LINE_PATTERN.test(line.trim())
}

function extractCanonicalUrl(block: string): string {
  const match = block.match(STATUS_URL_PATTERN)
  if (!match?.[1]) {
    return ""
  }
  return `https://x.com/Polymarket/status/${match[1]}`
}

function normalizeEmojiAltText(alt: string): string {
  const trimmed = alt.trim()
  const colonIndex = trimmed.lastIndexOf(":")
  if (colonIndex >= 0) {
    return trimmed.slice(colonIndex + 1).trim()
  }
  return trimmed
}

function extractMediaUrls(block: string): string[] {
  const mediaUrls = new Set<string>()
  for (const match of block.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const url = (match[2] || "").trim()
    if (!url) {
      continue
    }
    if (url.includes("/profile_images/")) {
      continue
    }
    if (url.includes("/emoji/")) {
      continue
    }
    mediaUrls.add(url)
  }
  return Array.from(mediaUrls)
}

function normalizeContentLines(lines: string[]): string[] {
  const normalized: string[] = []
  let previousBlank = false

  for (const rawLine of lines) {
    if (isProfileLine(rawLine)) {
      continue
    }
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (!previousBlank && normalized.length > 0) {
        normalized.push("")
      }
      previousBlank = true
      continue
    }

    const line = rawLine.replace(MARKDOWN_IMAGE_PATTERN, (_match, alt: string, url: string) => {
      if (typeof url === "string" && url.includes("/emoji/")) {
        return normalizeEmojiAltText(alt)
      }
      return ""
    })
    const cleaned = line
      .replace(/\[\s*\]\(([^)]+)\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()

    if (!cleaned) {
      continue
    }
    normalized.push(cleaned)
    previousBlank = false
  }

  while (normalized[normalized.length - 1] === "") {
    normalized.pop()
  }

  return normalized
}

function buildTitle(contentMarkdown: string): string {
  const firstLine = contentMarkdown.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() || ""
  if (!firstLine) {
    return "Polymarket 更新"
  }
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine
}

export function parsePolymarketTimeline(raw: string): ParsedPolymarketTimelineItem[] {
  const body = extractReaderMarkdownBody(raw)
  if (!body) {
    return []
  }
  const lines = body.split(/\r?\n/)
  const postsHeadingIndex = lines.findIndex((line) => POSTS_HEADING_PATTERN.test(line.trim()))
  const timelineLines = postsHeadingIndex >= 0 ? lines.slice(postsHeadingIndex + 1) : lines

  const blocks: Array<{ lines: string[]; pinned: boolean }> = []
  let currentLines: string[] = []
  let currentPinned = false
  let pendingPinned = false

  const pushCurrent = () => {
    if (currentLines.length === 0) {
      return
    }
    blocks.push({
      lines: currentLines,
      pinned: currentPinned,
    })
    currentLines = []
    currentPinned = false
  }

  for (const line of timelineLines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentLines.length > 0 && currentLines[currentLines.length - 1] !== "") {
        currentLines.push("")
      }
      continue
    }
    if (trimmed === "Pinned") {
      pendingPinned = true
      continue
    }
    if (isProfileLine(trimmed)) {
      pushCurrent()
      currentPinned = pendingPinned
      pendingPinned = false
      currentLines = [trimmed]
      continue
    }
    if (currentLines.length === 0) {
      continue
    }
    currentLines.push(line)
  }
  pushCurrent()

  return blocks
    .filter((block) => !block.pinned)
    .map((block) => {
      const blockText = block.lines.join("\n")
      const contentLines = normalizeContentLines(block.lines)
      const contentMarkdown = contentLines.join("\n").trim()
      return {
        title: buildTitle(contentMarkdown),
        contentMarkdown,
        mediaUrls: extractMediaUrls(blockText),
        canonicalUrl: extractCanonicalUrl(blockText),
        publishedAt: null,
      }
    })
    .filter((item) => item.contentMarkdown || item.mediaUrls.length > 0)
}
