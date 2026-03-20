import { getFeedSourceConfig } from "@/domain/feed/source-config"
import type { FeedSource } from "@/domain/feed/types"

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g

export interface ParsedPolymarketTimelineItem {
  title: string
  contentMarkdown: string
  mediaUrls: string[]
  canonicalUrl: string
  publishedAt: number | null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function extractReaderMarkdownBody(raw: string): string {
  const marker = "Markdown Content:"
  const index = raw.indexOf(marker)
  if (index < 0) {
    return raw.trim()
  }
  return raw.slice(index + marker.length).trim()
}

function buildPostsHeadingPattern(source: FeedSource): RegExp {
  const accountHandle = escapeRegExp(getFeedSourceConfig(source).accountHandle)
  return new RegExp(`^##\\s+${accountHandle}(?:’|')s posts\\s*$`, "i")
}

function buildProfileLinePattern(source: FeedSource): RegExp {
  const accountHandle = escapeRegExp(getFeedSourceConfig(source).accountHandle)
  return new RegExp(
    String.raw`^\[!\[[^\]]*profile picture[^\]]*\]\(https?:\/\/pbs\.twimg\.com\/profile_images\/[^)]+\)\]\(https?:\/\/x\.com\/${accountHandle}(?:\/photo)?\)$`,
    "i"
  )
}

function buildPostProfileLinePattern(source: FeedSource): RegExp {
  const accountHandle = escapeRegExp(getFeedSourceConfig(source).accountHandle)
  return new RegExp(
    String.raw`^\[!\[[^\]]*Square profile picture[^\]]*\]\(https?:\/\/pbs\.twimg\.com\/profile_images\/[^)]+\)\]\(https?:\/\/x\.com\/${accountHandle}\)$`,
    "i"
  )
}

function buildStatusUrlPattern(source: FeedSource): RegExp {
  const accountHandle = escapeRegExp(getFeedSourceConfig(source).accountHandle)
  return new RegExp(`https?://x\\.com/${accountHandle}/status/(\\d+)`, "i")
}

function isProfileLine(line: string, source: FeedSource): boolean {
  return buildProfileLinePattern(source).test(line.trim())
}

function isPostProfileLine(line: string, source: FeedSource): boolean {
  return buildPostProfileLinePattern(source).test(line.trim())
}

function isStatusMetaLine(line: string, source: FeedSource): boolean {
  const trimmed = line.trim()
  const statusPattern = buildStatusUrlPattern(source)
  return (
    new RegExp(
      String.raw`^\[[^\]]+\]\(https?:\/\/x\.com\/${escapeRegExp(
        getFeedSourceConfig(source).accountHandle
      )}\/status\/\d+(?:\/analytics)?\)$`,
      "i"
    ).test(trimmed) || statusPattern.test(trimmed) && /^\[[^\]]+\]\(/.test(trimmed)
  )
}

function isFeedUiMetaLine(line: string, source: FeedSource): boolean {
  const trimmed = line.trim()
  if (!trimmed) {
    return false
  }
  const accountHandle = getFeedSourceConfig(source).accountHandle
  const accountPattern = new RegExp(
    String.raw`^\[@?${escapeRegExp(accountHandle)}\]\(https?:\/\/x\.com\/${escapeRegExp(accountHandle)}\)$`,
    "i"
  )
  if (accountPattern.test(trimmed)) {
    return true
  }
  if (trimmed === "·" || trimmed === "Show more") {
    return true
  }
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    return true
  }
  if (/^\d+(?:\.\d+)?[KMB]?$/i.test(trimmed)) {
    return true
  }
  return false
}

function isTimelineFooterLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) {
    return false
  }
  return (
    trimmed === "## X 新用户？" ||
    trimmed === "立即注册，获取你自己的个性化时间线！" ||
    trimmed === "使用 Apple 注册" ||
    trimmed === "更多" ||
    /^©\s*\d{4}\s+X Corp\.$/i.test(trimmed) ||
    /^\[创建账户\]\(https?:\/\/x\.com\/i\/flow\/signup\)$/i.test(trimmed) ||
    /^\[Log in\]\(https?:\/\/x\.com\/login\)$/i.test(trimmed) ||
    /^\[Sign up\]\(https?:\/\/x\.com\/i\/flow\/signup\)$/i.test(trimmed) ||
    /^注册即表示你同意 /u.test(trimmed) ||
    /^\[(服务条款|隐私政策|Cookie 政策|无障碍访问|广告信息)\]\(/u.test(trimmed) ||
    trimmed === "|"
  )
}

function extractCanonicalUrl(block: string, source: FeedSource): string {
  const match = block.match(buildStatusUrlPattern(source))
  if (!match?.[1]) {
    return ""
  }
  return `https://x.com/${getFeedSourceConfig(source).accountHandle}/status/${match[1]}`
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

function normalizeContentLines(lines: string[], source: FeedSource): string[] {
  const normalized: string[] = []
  let previousBlank = false

  for (const rawLine of lines) {
    if (
      isProfileLine(rawLine, source) ||
      isStatusMetaLine(rawLine, source) ||
      isFeedUiMetaLine(rawLine, source) ||
      isTimelineFooterLine(rawLine)
    ) {
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

function buildTitle(contentMarkdown: string, source: FeedSource): string {
  const firstLine = contentMarkdown.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() || ""
  if (!firstLine) {
    return getFeedSourceConfig(source).fallbackTitle
  }
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine
}

export function parseXTimeline(raw: string, source: FeedSource): ParsedPolymarketTimelineItem[] {
  const body = extractReaderMarkdownBody(raw)
  if (!body) {
    return []
  }
  const lines = body.split(/\r?\n/)
  const postsHeadingIndex = lines.findIndex((line) => buildPostsHeadingPattern(source).test(line.trim()))
  const firstPostIndex =
    postsHeadingIndex >= 0
      ? postsHeadingIndex + 1
      : lines.findIndex((line) => isPostProfileLine(line, source))
  const timelineLines = firstPostIndex >= 0 ? lines.slice(firstPostIndex) : lines

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
    if (isTimelineFooterLine(trimmed)) {
      break
    }
    if (trimmed === "Pinned") {
      pendingPinned = true
      continue
    }
    if (isPostProfileLine(trimmed, source)) {
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
      const contentLines = normalizeContentLines(block.lines, source)
      const contentMarkdown = contentLines.join("\n").trim()
      return {
        title: buildTitle(contentMarkdown, source),
        contentMarkdown,
        mediaUrls: extractMediaUrls(blockText),
        canonicalUrl: extractCanonicalUrl(blockText, source),
        publishedAt: null,
      }
    })
    .filter((item) => item.contentMarkdown || item.mediaUrls.length > 0)
}

export function parsePolymarketTimeline(raw: string): ParsedPolymarketTimelineItem[] {
  return parseXTimeline(raw, "polymarket")
}

export function parseKalshiTimeline(raw: string): ParsedPolymarketTimelineItem[] {
  return parseXTimeline(raw, "kalshi")
}
