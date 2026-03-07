import type {
  ChatAnchors,
  ChatCardAttachmentPayload,
  ChatCitationCard,
  ChatDeepSearchResearch,
  ChatInlineCitation,
  ChatMessage,
  ChatReasoningEventDetail,
  ChatTurnResult,
} from "../../domain/chat/types"
import {
  type WebSearchToolMeta,
  appendToolMeta,
  extractInlineCitationsFromText,
  isRecord,
  resolveConversationTitle,
} from "./chunk-parsers"
import { extractGeneratedImageMarkdown, isGeneratedImageNarration } from "./gateway-media-assets"
import {
  type GeneratedImageCardHydrator,
  type RenewedAssetUrlCache,
  finalizeGeneratedMediaArtifacts,
} from "./gateway-media-workflows"

const GENERATED_IMAGE_MODERATED_NOTICE = "内容已管理。请尝试一个不同的想法。"

export interface GatewayTurnCompletionState {
  upstreamConversationTitle: string
  assistantText: string
  gatewayFinalMessage: string
  collectedWebSearchMeta: WebSearchToolMeta[]
  collectedCards: ChatCardAttachmentPayload[]
  collectedReasoningEvents: ChatReasoningEventDetail[]
  collectedResearch?: ChatDeepSearchResearch
  hasStructuredGeneratedImages: boolean
  hasModeratedGeneratedImages: boolean
  reasoningStartedAtMs: number | null
  reasoningEndedAtMs: number | null
}

export function mergeResearchPayload(
  previous: ChatDeepSearchResearch | undefined,
  next: Partial<ChatDeepSearchResearch> | undefined
): ChatDeepSearchResearch | undefined {
  const base = previous || {}
  const incoming = next || {}
  const merged: ChatDeepSearchResearch = {
    requestMetadata:
      incoming.requestMetadata && Object.keys(incoming.requestMetadata).length > 0
        ? incoming.requestMetadata
        : base.requestMetadata,
    uiLayout: incoming.uiLayout || base.uiLayout,
    deepsearchPreset: incoming.deepsearchPreset || base.deepsearchPreset,
    thinkingStartTime: incoming.thinkingStartTime || base.thinkingStartTime,
    thinkingEndTime: incoming.thinkingEndTime || base.thinkingEndTime,
  }

  const citationMap = new Map<string, ChatCitationCard>()
  for (const row of [...(base.citationCards || []), ...(incoming.citationCards || [])]) {
    const key = `${row.cardId}\u0000${row.url || ""}`
    if (!citationMap.has(key)) {
      citationMap.set(key, row)
    }
  }
  if (citationMap.size > 0) {
    merged.citationCards = Array.from(citationMap.values())
  }

  const inlineMap = new Map<string, ChatInlineCitation>()
  for (const row of [...(base.inlineCitations || []), ...(incoming.inlineCitations || [])]) {
    const key = `${row.cardId}\u0000${row.citationId || ""}\u0000${row.url || ""}`
    if (!inlineMap.has(key)) {
      inlineMap.set(key, row)
    }
  }
  if (inlineMap.size > 0) {
    merged.inlineCitations = Array.from(inlineMap.values())
  }

  const detailMap = new Map<string, { title: string; bullets: string[] }>()
  for (const row of [...(base.details || []), ...(incoming.details || [])]) {
    const title = row.title.trim()
    const bullets = row.bullets.map((item) => item.trim()).filter(Boolean)
    const key = `${title}\u0000${bullets.join("\u0001")}`
    if (!detailMap.has(key)) {
      detailMap.set(key, {
        title: title || "深度挖掘细节",
        bullets,
      })
    }
  }
  if (detailMap.size > 0) {
    merged.details = Array.from(detailMap.values())
  }

  const stepMap = new Map<string, NonNullable<ChatDeepSearchResearch["steps"]>[number]>()
  for (const step of [...(base.steps || []), ...(incoming.steps || [])]) {
    const tags = step.tags.map((row) => row.trim()).filter(Boolean)
    const text = step.text.map((row) => row.trim()).filter(Boolean)
    const toolUsageCardIds = (step.toolUsageCardIds || []).map((row) => row.trim()).filter(Boolean)
    const toolUsages: NonNullable<NonNullable<ChatDeepSearchResearch["steps"]>[number]["toolUsages"]> = []
    for (const usage of step.toolUsages || []) {
      const toolUsageCardId = (usage.toolUsageCardId || "").trim()
      if (!toolUsageCardId) {
        continue
      }
      toolUsages.push({
        toolUsageCardId,
        toolName: (usage.toolName || "").trim() || "tool",
        args: isRecord(usage.args) ? usage.args : {},
        webSearchResults: Array.isArray(usage.webSearchResults)
          ? usage.webSearchResults.map((row) => {
              const authorName = (row.authorName || "").trim()
              const authorHandle = (row.authorHandle || "").trim()
              const publishedAt = (row.publishedAt || "").trim()
              const postId = (row.postId || "").trim()
              return {
                ...(row.kind === "x_post" ? { kind: "x_post" as const } : {}),
                title: (row.title || "").trim() || undefined,
                url: (row.url || "").trim() || undefined,
                preview: (row.preview || "").trim() || undefined,
                favicon: (row.favicon || "").trim() || undefined,
                ...(authorName ? { authorName } : {}),
                ...(authorHandle ? { authorHandle } : {}),
                ...(publishedAt ? { publishedAt } : {}),
                ...(postId ? { postId } : {}),
              }
            })
          : undefined,
      })
    }
    const title = (step.title || "").trim()
    const key = `${tags.join("\u0001")}\u0000${title}\u0000${text.join("\u0001")}\u0000${toolUsageCardIds.join("\u0001")}\u0000${toolUsages
      .map(
        (usage) =>
          `${usage.toolUsageCardId}\u0001${usage.toolName}\u0001${JSON.stringify(usage.args)}\u0001${(usage.webSearchResults || [])
            .map((row) => `${row.url || ""}\u0002${row.title || ""}`)
            .join("\u0003")}`
      )
      .join("\u0004")}`
    if (stepMap.has(key)) {
      continue
    }
    stepMap.set(key, {
      tags,
      title: title || undefined,
      text,
      toolUsageCardIds: toolUsageCardIds.length > 0 ? toolUsageCardIds : undefined,
      toolUsages: toolUsages.length > 0 ? toolUsages : undefined,
    })
  }
  if (stepMap.size > 0) {
    merged.steps = Array.from(stepMap.values())
  }

  const hasPayload = Boolean(
    merged.requestMetadata ||
      merged.uiLayout ||
      (merged.deepsearchPreset || "").trim() ||
      (merged.thinkingStartTime || "").trim() ||
      (merged.thinkingEndTime || "").trim() ||
      (merged.steps && merged.steps.length > 0) ||
      (merged.citationCards && merged.citationCards.length > 0) ||
      (merged.inlineCitations && merged.inlineCitations.length > 0) ||
      (merged.details && merged.details.length > 0)
  )
  return hasPayload ? merged : undefined
}

function hasAnyThinkTag(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.includes("<think") || lower.includes("</think>")
}

function resolveReasoningDurationFromResearch(research: ChatDeepSearchResearch | undefined): number {
  if (!research) {
    return 0
  }
  const startedAtMs = Date.parse((research.thinkingStartTime || "").trim())
  const endedAtMs = Date.parse((research.thinkingEndTime || "").trim())
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return 0
  }
  if (endedAtMs <= startedAtMs) {
    return 0
  }
  return Math.max(1, Math.round((endedAtMs - startedAtMs) / 1000))
}

function resolveReasoningDurationFromLocalWindow(
  reasoningStartedAtMs: number | null,
  reasoningEndedAtMs: number | null,
  nowMs: number
): number {
  if (!reasoningStartedAtMs || reasoningStartedAtMs <= 0) {
    return 0
  }
  const endMs =
    reasoningEndedAtMs && reasoningEndedAtMs > reasoningStartedAtMs
      ? reasoningEndedAtMs
      : nowMs
  if (endMs <= reasoningStartedAtMs) {
    return 0
  }
  return Math.max(1, Math.round((endMs - reasoningStartedAtMs) / 1000))
}

function toCitationCardFromAttachment(card: ChatCardAttachmentPayload): ChatCitationCard | null {
  const cardType = (card.cardType || card.type || "").trim()
  if (!cardType.toLowerCase().includes("citation")) {
    return null
  }
  const cardId = (card.id || "").trim()
  if (!cardId) {
    return null
  }
  return {
    cardId,
    cardType: cardType || undefined,
    url: (card.url || card.image?.link || "").trim() || undefined,
  }
}

export async function buildCompletedGatewayTurn(input: {
  state: GatewayTurnCompletionState
  apiUrl: string
  hydrateGeneratedImageCards: GeneratedImageCardHydrator
  renewCache?: RenewedAssetUrlCache
  gatewayResponseId: string
  sessionId: string
  conversationId: string
  previousResponseId: string
  currentTitle: string
  fallbackTitle: string
  streamStartedAt: number
  commitTime: number
}): Promise<{
  result: ChatTurnResult
  resolvedTitle: string
}> {
  let assistantText = input.state.assistantText
  let gatewayFinalMessage = input.state.gatewayFinalMessage
  let collectedResearch = input.state.collectedResearch

  const finalizedGeneratedMedia = await finalizeGeneratedMediaArtifacts({
    cards: input.state.collectedCards,
    reasoningEvents: input.state.collectedReasoningEvents,
    apiUrl: input.apiUrl,
    hydrateGeneratedImageCards: input.hydrateGeneratedImageCards,
    renewCache: input.renewCache,
  })
  const collectedCards = finalizedGeneratedMedia.cards
  const normalizedReasoningEvents = finalizedGeneratedMedia.reasoningEvents

  const citationCardsFromAttachments = collectedCards
    .map((card) => toCitationCardFromAttachment(card))
    .filter((row): row is ChatCitationCard => Boolean(row))
  collectedResearch = mergeResearchPayload(collectedResearch, {
    citationCards: citationCardsFromAttachments,
  })

  if (input.state.hasStructuredGeneratedImages) {
    assistantText = extractGeneratedImageMarkdown(collectedCards)
    gatewayFinalMessage = ""
  }

  if (input.state.hasModeratedGeneratedImages) {
    const notice = `_${GENERATED_IMAGE_MODERATED_NOTICE}_`
    assistantText = assistantText.trim() ? `${assistantText}\n\n${notice}` : notice
    gatewayFinalMessage = ""
  }

  if (!assistantText && gatewayFinalMessage && !isGeneratedImageNarration(gatewayFinalMessage)) {
    assistantText = gatewayFinalMessage
  }

  const inlineCitationsFromText = extractInlineCitationsFromText(gatewayFinalMessage || assistantText)
  if (inlineCitationsFromText.length > 0) {
    collectedResearch = mergeResearchPayload(collectedResearch, {
      inlineCitations: inlineCitationsFromText,
    })
  }

  const assistantContent = appendToolMeta(assistantText, {
    webSearch: input.state.collectedWebSearchMeta,
    cards: collectedCards,
  })
  const durationFromResearch = resolveReasoningDurationFromResearch(collectedResearch)
  const durationFromLocalWindow = resolveReasoningDurationFromLocalWindow(
    input.state.reasoningStartedAtMs,
    input.state.reasoningEndedAtMs,
    input.commitTime
  )
  const finalDurationSeconds =
    durationFromResearch ||
    durationFromLocalWindow ||
    Math.max(1, Math.round((input.commitTime - input.streamStartedAt) / 1000))
  const reasoningEventCount = normalizedReasoningEvents?.length || 0
  const shouldPersistReasoningDuration = reasoningEventCount > 0 || hasAnyThinkTag(assistantText)

  const assistantMessage: ChatMessage = {
    id: input.gatewayResponseId || `asst_${crypto.randomUUID()}`,
    role: "assistant",
    content: assistantContent,
    createdAt: input.commitTime,
    reasoningEvents: reasoningEventCount > 0 ? normalizedReasoningEvents : undefined,
    reasoningDurationSeconds: shouldPersistReasoningDuration ? finalDurationSeconds : undefined,
    research: collectedResearch,
    responseId: input.gatewayResponseId || undefined,
    previousResponseId: input.previousResponseId || undefined,
    status: "completed",
  }
  const anchors: ChatAnchors = {
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    lastResponseId: input.gatewayResponseId || input.previousResponseId || "",
  }
  const resolvedTitle =
    resolveConversationTitle(input.state.upstreamConversationTitle, input.currentTitle) ||
    input.fallbackTitle

  return {
    result: {
      assistantMessage,
      anchors,
    },
    resolvedTitle,
  }
}
