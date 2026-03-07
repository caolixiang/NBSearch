import type { ChatCardAttachmentPayload, ChatMessage, ChatReasoningEventDetail } from "../../domain/chat/types"
import { isRecord } from "./chunk-parsers"
import {
  type RenewedAssetUrlPayload,
  applyUrlReplacementsOutsideToolMeta,
  appendMissingCardsFromReasoningEvents,
  appendMissingGeneratedImageMarkdownOutsideToolMeta,
  cloneCardAttachmentPayload,
  coerceToolMetaCard,
  collectCardUrlReplacements,
  collectGeneratedImageUrls,
  dedupeGeneratedImageCards,
  mergeRenewedCardsIntoReasoningEvents,
  normalizeGeneratedImageCardsInReasoningEvents,
  pruneGeneratedImageMarkdownOutsideToolMeta,
} from "./gateway-media-assets"

export type RenewedAssetUrlCache = Map<string, Promise<RenewedAssetUrlPayload | null>>

export type GeneratedImageCardHydrator = (
  cards: ChatCardAttachmentPayload[],
  sharedRenewCache?: RenewedAssetUrlCache
) => Promise<void>

export async function finalizeGeneratedMediaArtifacts(input: {
  cards: ChatCardAttachmentPayload[]
  reasoningEvents: ChatReasoningEventDetail[] | undefined
  apiUrl: string
  hydrateGeneratedImageCards: GeneratedImageCardHydrator
  renewCache?: RenewedAssetUrlCache
}): Promise<{
  cards: ChatCardAttachmentPayload[]
  reasoningEvents: ChatReasoningEventDetail[] | undefined
}> {
  const cards = input.cards.map((card) => cloneCardAttachmentPayload(card))
  const renewCache = input.renewCache || new Map<string, Promise<RenewedAssetUrlPayload | null>>()

  if (cards.length > 0) {
    await input.hydrateGeneratedImageCards(cards, renewCache)
    const dedupedCards = dedupeGeneratedImageCards(cards, input.apiUrl)
    cards.splice(0, cards.length, ...dedupedCards)
  }

  const reasoningEvents = await normalizeGeneratedImageCardsInReasoningEvents(
    input.reasoningEvents,
    input.hydrateGeneratedImageCards,
    renewCache
  )

  return {
    cards,
    reasoningEvents,
  }
}

export async function refreshMessagesWithGeneratedMediaAssets(input: {
  messages: ChatMessage[]
  apiUrl: string
  hydrateGeneratedImageCards: GeneratedImageCardHydrator
}): Promise<{
  messages: ChatMessage[]
  updated: ChatMessage[]
}> {
  const refreshed: ChatMessage[] = []
  const updated: ChatMessage[] = []
  const renewCache = new Map<string, Promise<RenewedAssetUrlPayload | null>>()

  for (const message of input.messages) {
    if (message.role !== "assistant" || !message.content.includes("<tool-meta>")) {
      refreshed.push(message)
      continue
    }

    const regex = /<tool-meta>([\s\S]*?)<\/tool-meta>/gi
    const matches = Array.from(message.content.matchAll(regex))
    if (matches.length === 0) {
      refreshed.push(message)
      continue
    }

    let nextContent = message.content
    let offset = 0
    let changed = false
    const replacementByUrl = new Map<string, string>()
    const renewedCardsById = new Map<string, ChatCardAttachmentPayload>()
    const ensuredMarkdownImageUrls = new Set<string>()

    for (const match of matches) {
      const fullBlock = match[0]
      const payloadText = match[1]?.trim() || ""
      if (!payloadText || typeof match.index !== "number") {
        continue
      }

      let payload: unknown
      try {
        payload = JSON.parse(payloadText) as unknown
      } catch {
        continue
      }
      if (!isRecord(payload) || !Array.isArray(payload.cards)) {
        continue
      }

      const cards = payload.cards.map((item) => coerceToolMetaCard(item)).filter((item): item is ChatCardAttachmentPayload => Boolean(item))
      if (cards.length === 0) {
        continue
      }

      const payloadCardsBefore = cards.map((card) => cloneCardAttachmentPayload(card))
      const restoredCards = appendMissingCardsFromReasoningEvents(cards, message.reasoningEvents)
      for (const restoredCard of restoredCards) {
        if ((restoredCard.type || "").toLowerCase() !== "generated_image") {
          continue
        }
        const restoredUrl = (restoredCard.image?.original || restoredCard.url || "").trim()
        if (!/^https?:\/\//i.test(restoredUrl)) {
          continue
        }
        ensuredMarkdownImageUrls.add(restoredUrl)
      }

      const cardsBeforeHydration = cards.map((card) => cloneCardAttachmentPayload(card))
      const finalized = await finalizeGeneratedMediaArtifacts({
        cards,
        reasoningEvents: undefined,
        apiUrl: input.apiUrl,
        hydrateGeneratedImageCards: input.hydrateGeneratedImageCards,
        renewCache,
      })
      cards.splice(0, cards.length, ...finalized.cards)
      for (const imageUrl of collectGeneratedImageUrls(cards)) {
        ensuredMarkdownImageUrls.add(imageUrl)
      }

      const payloadChanged = JSON.stringify(payloadCardsBefore) !== JSON.stringify(cards)
      if (!payloadChanged) {
        continue
      }

      const replacements = collectCardUrlReplacements(cardsBeforeHydration, cards)
      for (const [from, to] of replacements.entries()) {
        replacementByUrl.set(from, to)
      }
      for (const card of cards) {
        const id = (card.id || "").trim()
        if (!id) {
          continue
        }
        renewedCardsById.set(id, card)
      }

      payload.cards = cards
      const nextBlock = `<tool-meta>${JSON.stringify(payload)}</tool-meta>`
      const start = match.index + offset
      const end = start + fullBlock.length
      nextContent = `${nextContent.slice(0, start)}${nextBlock}${nextContent.slice(end)}`
      offset += nextBlock.length - fullBlock.length
      changed = true
    }

    const mergedReasoningEvents = mergeRenewedCardsIntoReasoningEvents(
      message.reasoningEvents,
      renewedCardsById
    )
    const finalizedReasoning = await finalizeGeneratedMediaArtifacts({
      cards: [],
      reasoningEvents: mergedReasoningEvents,
      apiUrl: input.apiUrl,
      hydrateGeneratedImageCards: input.hydrateGeneratedImageCards,
      renewCache,
    })
    const normalizedReasoningEvents = finalizedReasoning.reasoningEvents
    const reasoningChanged =
      JSON.stringify(message.reasoningEvents || []) !== JSON.stringify(normalizedReasoningEvents || [])

    if (!changed && !reasoningChanged) {
      refreshed.push(message)
      continue
    }

    const replacedContent = changed
      ? applyUrlReplacementsOutsideToolMeta(nextContent, replacementByUrl)
      : message.content
    const prunedContent = changed
      ? pruneGeneratedImageMarkdownOutsideToolMeta(replacedContent, ensuredMarkdownImageUrls)
      : replacedContent
    const nextVisibleContent = changed
      ? appendMissingGeneratedImageMarkdownOutsideToolMeta(prunedContent, ensuredMarkdownImageUrls)
      : prunedContent

    const nextMessage = {
      ...message,
      content: nextVisibleContent,
      reasoningEvents: normalizedReasoningEvents,
    }
    refreshed.push(nextMessage)
    updated.push(nextMessage)
  }

  return {
    messages: refreshed,
    updated,
  }
}
