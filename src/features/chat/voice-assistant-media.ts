import type { ChatCardAttachmentPayload, ChatReasoningEventDetail } from "@/domain/chat/types"

function normalizeCardId(card: ChatCardAttachmentPayload): string {
  return (card.id || "").trim()
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
