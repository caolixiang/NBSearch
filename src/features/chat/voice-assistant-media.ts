import type { ChatCardAttachmentPayload, ChatMessage, ChatReasoningEventDetail } from "@/domain/chat/types"

function normalizeCardId(card: ChatCardAttachmentPayload): string {
  return (card.id || "").trim()
}

function cloneCardImage(image: ChatCardAttachmentPayload["image"]): ChatCardAttachmentPayload["image"] {
  if (!image) {
    return undefined
  }
  return {
    ...(image.thumbnail ? { thumbnail: image.thumbnail } : {}),
    ...(image.original ? { original: image.original } : {}),
    ...(image.title ? { title: image.title } : {}),
    ...(image.link ? { link: image.link } : {}),
    ...(image.source ? { source: image.source } : {}),
  }
}

function cloneVoiceAssistantCard(card: ChatCardAttachmentPayload): ChatCardAttachmentPayload {
  return {
    id: card.id,
    ...(card.cardType ? { cardType: card.cardType } : {}),
    ...(card.type ? { type: card.type } : {}),
    ...(card.url ? { url: card.url } : {}),
    ...(card.assetId ? { assetId: card.assetId } : {}),
    ...(card.asset_id ? { asset_id: card.asset_id } : {}),
    ...(card.rawUrl ? { rawUrl: card.rawUrl } : {}),
    ...(card.urlExpiresAt ? { urlExpiresAt: card.urlExpiresAt } : {}),
    ...(card.image ? { image: cloneCardImage(card.image) } : {}),
  }
}

function collectVoiceAssistantCardsFromReasoningEvents(
  reasoningEvents: ChatReasoningEventDetail[] | undefined
): ChatCardAttachmentPayload[] {
  if (!Array.isArray(reasoningEvents) || reasoningEvents.length === 0) {
    return []
  }

  return reasoningEvents
    .map((event) => (event.kind === "card_attachment" ? cloneVoiceAssistantCard(event.card) : null))
    .filter((card): card is ChatCardAttachmentPayload => Boolean(card))
}

function coerceVoiceAssistantToolMetaCard(value: unknown): ChatCardAttachmentPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id.trim() : ""
  if (!id) {
    return null
  }

  const imageValue =
    record.image && typeof record.image === "object" && !Array.isArray(record.image)
      ? (record.image as Record<string, unknown>)
      : null

  return {
    id,
    ...(typeof record.cardType === "string" && record.cardType.trim() ? { cardType: record.cardType } : {}),
    ...(typeof record.type === "string" && record.type.trim() ? { type: record.type } : {}),
    ...(typeof record.url === "string" && record.url.trim() ? { url: record.url } : {}),
    ...(typeof record.assetId === "string" && record.assetId.trim() ? { assetId: record.assetId } : {}),
    ...(typeof record.asset_id === "string" && record.asset_id.trim() ? { asset_id: record.asset_id } : {}),
    ...(typeof record.rawUrl === "string" && record.rawUrl.trim() ? { rawUrl: record.rawUrl } : {}),
    ...(typeof record.urlExpiresAt === "string" && record.urlExpiresAt.trim()
      ? { urlExpiresAt: record.urlExpiresAt }
      : {}),
    ...(imageValue
      ? {
          image: {
            ...(typeof imageValue.thumbnail === "string" && imageValue.thumbnail.trim()
              ? { thumbnail: imageValue.thumbnail }
              : {}),
            ...(typeof imageValue.original === "string" && imageValue.original.trim()
              ? { original: imageValue.original }
              : {}),
            ...(typeof imageValue.title === "string" && imageValue.title.trim() ? { title: imageValue.title } : {}),
            ...(typeof imageValue.link === "string" && imageValue.link.trim() ? { link: imageValue.link } : {}),
            ...(typeof imageValue.source === "string" && imageValue.source.trim()
              ? { source: imageValue.source }
              : {}),
          },
        }
      : {}),
  }
}

function collectVoiceAssistantCardsFromToolMeta(content: string): ChatCardAttachmentPayload[] {
  if (!content || !content.includes("<tool-meta>")) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []
  const matches = Array.from(content.matchAll(/<tool-meta>([\s\S]*?)<\/tool-meta>/gi))
  for (const match of matches) {
    const payloadText = match[1]?.trim() || ""
    if (!payloadText) {
      continue
    }
    try {
      const parsed = JSON.parse(payloadText) as { cards?: unknown }
      if (!Array.isArray(parsed.cards)) {
        continue
      }
      for (const card of parsed.cards) {
        const normalized = coerceVoiceAssistantToolMetaCard(card)
        if (normalized) {
          cards.push(normalized)
        }
      }
    } catch {
      continue
    }
  }

  return cards
}

function stripVoiceAssistantToolMeta(content: string): string {
  return content.replace(/<tool-meta>[\s\S]*?<\/tool-meta>/gi, "").trim()
}

function collectVoiceAssistantMessageCards(message: ChatMessage): ChatCardAttachmentPayload[] {
  const cardsFromToolMeta = collectVoiceAssistantCardsFromToolMeta(message.content)
  const cardsFromReasoningEvents = collectVoiceAssistantCardsFromReasoningEvents(message.reasoningEvents)
  return mergeVoiceAssistantCards(cardsFromToolMeta, cardsFromReasoningEvents)
}

export function mergeVoiceAssistantCards(
  current: ChatCardAttachmentPayload[],
  incoming: ChatCardAttachmentPayload[]
): ChatCardAttachmentPayload[] {
  if (incoming.length === 0) {
    return current
  }

  const order: string[] = []
  const byId = new Map<string, ChatCardAttachmentPayload>()

  for (const card of current) {
    const id = normalizeCardId(card)
    if (!id || byId.has(id)) {
      continue
    }
    order.push(id)
    byId.set(id, card)
  }

  for (const card of incoming) {
    const id = normalizeCardId(card)
    if (!id) {
      continue
    }
    if (!byId.has(id)) {
      order.push(id)
    }
    byId.set(id, card)
  }

  return order.map((id) => byId.get(id)).filter((card): card is ChatCardAttachmentPayload => Boolean(card))
}

export function buildVoiceAssistantReasoningEvents(cards: ChatCardAttachmentPayload[]): ChatReasoningEventDetail[] {
  return cards.map((card) => ({
    kind: "card_attachment",
    card,
  }))
}

export function buildVoiceAssistantMessageContent(text: string, cards: ChatCardAttachmentPayload[]): string {
  const normalizedText = text.trim()
  if (cards.length === 0) {
    return normalizedText
  }

  const toolMeta = `<tool-meta>${JSON.stringify({ webSearch: [], cards })}</tool-meta>`
  return normalizedText ? `${normalizedText}\n${toolMeta}` : toolMeta
}

export function backfillVoiceAssistantMessageCards(
  message: ChatMessage,
  incoming: ChatCardAttachmentPayload[]
): ChatMessage | null {
  if (message.role !== "assistant" || incoming.length === 0) {
    return null
  }

  const currentCards = collectVoiceAssistantMessageCards(message)
  const mergedCards = mergeVoiceAssistantCards(currentCards, incoming)
  const nextReasoningEvents = buildVoiceAssistantReasoningEvents(mergedCards)
  const nextContent = buildVoiceAssistantMessageContent(stripVoiceAssistantToolMeta(message.content), mergedCards)

  const reasoningUnchanged =
    JSON.stringify(message.reasoningEvents || []) === JSON.stringify(nextReasoningEvents)
  const contentUnchanged = message.content === nextContent
  if (reasoningUnchanged && contentUnchanged) {
    return null
  }

  return {
    ...message,
    content: nextContent,
    reasoningEvents: nextReasoningEvents,
  }
}
