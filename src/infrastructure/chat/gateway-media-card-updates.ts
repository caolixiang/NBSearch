import type { ChatCardAttachmentPayload } from "../../domain/chat/types"

export function collectCardUrlReplacements(
  beforeCards: ChatCardAttachmentPayload[],
  afterCards: ChatCardAttachmentPayload[]
): Map<string, string> {
  const replacements = new Map<string, string>()
  const beforeById = new Map<string, ChatCardAttachmentPayload>()
  for (const card of beforeCards) {
    const id = (card.id || "").trim()
    if (!id) {
      continue
    }
    beforeById.set(id, card)
  }

  for (const nextCard of afterCards) {
    const id = (nextCard.id || "").trim()
    if (!id) {
      continue
    }
    const previousCard = beforeById.get(id)
    if (!previousCard) {
      continue
    }

    const nextUrl = (nextCard.image?.original || nextCard.url || "").trim()
    if (!nextUrl || !/^https?:\/\//i.test(nextUrl)) {
      continue
    }

    const candidates = [
      (previousCard.image?.original || "").trim(),
      (previousCard.url || "").trim(),
    ]

    for (const previousUrl of candidates) {
      if (!previousUrl || previousUrl === nextUrl || !/^https?:\/\//i.test(previousUrl)) {
        continue
      }
      replacements.set(previousUrl, nextUrl)
    }
  }

  return replacements
}

export function applyUrlReplacementsOutsideToolMeta(content: string, replacements: Map<string, string>): string {
  if (!content || replacements.size === 0) {
    return content
  }

  const entries = Array.from(replacements.entries())
    .filter(([from, to]) => Boolean(from) && Boolean(to) && from !== to)
    .sort((a, b) => b[0].length - a[0].length)

  if (entries.length === 0) {
    return content
  }

  const segments = content.split(/(<tool-meta>[\s\S]*?<\/tool-meta>)/gi)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] || ""
    if (/^<tool-meta>[\s\S]*<\/tool-meta>$/i.test(segment)) {
      continue
    }

    let nextSegment = segment
    for (const [from, to] of entries) {
      if (!nextSegment.includes(from)) {
        continue
      }
      nextSegment = nextSegment.split(from).join(to)
    }
    segments[index] = nextSegment
  }

  return segments.join("")
}
