import type {
  ChatCardAttachmentPayload,
  ChatDeepSearchResearch,
  ChatReasoningEventDetail,
} from "../../domain/chat/types"
import {
  type WebSearchToolMeta,
  extractCardAttachmentsFromRawChunk,
  extractChunkIsThinking,
  extractDeepSearchResearchFromRawChunk,
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractGeneratedImageModeratedFromRawChunk,
  extractReasoningEventsFromRawChunk,
  extractResponseNewTitleFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
} from "./chunk-parsers"
import {
  canonicalizeGeneratedImagePath,
  inferGeneratedImageAssetId,
  isGeneratedImageNarration,
  isLocalRenewableImageAssetId,
  normalizeCardAttachmentUrls,
  preferGeneratedCardByUrlQuality,
  readCardAssetMeta,
  withCardAssetMeta,
} from "./gateway-media-assets"
import { type GatewayTurnCompletionState, mergeResearchPayload } from "./gateway-turn-completion"

export interface GatewayStreamChunkBatch {
  delta: string
  reasoningDetails: ChatReasoningEventDetail[]
  responseId: string
}

export function readReasoningEventResponseId(detail: ChatReasoningEventDetail): string {
  if (detail.kind === "ui_layout") {
    return detail.responseId?.trim() || ""
  }
  if (detail.kind === "tool_usage") {
    return detail.usage.responseId?.trim() || ""
  }
  if (detail.kind === "tool_result") {
    return detail.result.responseId?.trim() || ""
  }
  return ""
}

export class GatewayStreamAccumulator {
  private gatewayResponseId = ""
  private upstreamConversationTitle = ""
  private assistantText = ""
  private gatewayFinalMessage = ""
  private readonly collectedWebSearchMeta: WebSearchToolMeta[] = []
  private readonly collectedWebSearchSeen = new Set<string>()
  private readonly collectedCards: ChatCardAttachmentPayload[] = []
  private readonly collectedCardIds = new Set<string>()
  private readonly generatedImageIndexByCanonical = new Map<string, number>()
  private readonly generatedImageIndexByAssetId = new Map<string, number>()
  private readonly collectedReasoningEvents: ChatReasoningEventDetail[] = []
  private collectedResearch: ChatDeepSearchResearch | undefined
  private hasStructuredGeneratedImages = false
  private hasModeratedGeneratedImages = false
  private hasVisibleAssistantDelta = false
  private reasoningStartedAtMs: number | null = null
  private reasoningEndedAtMs: number | null = null
  private wasThinking = false
  private readonly pendingToolUsageCardIds = new Set<string>()

  constructor(private readonly apiUrl: string) {}

  getResponseId(): string {
    return this.gatewayResponseId
  }

  shouldRetryIdleTimeout(): boolean {
    return (
      !this.assistantText.trim() &&
      !this.gatewayFinalMessage.trim() &&
      this.collectedReasoningEvents.length === 0 &&
      !this.hasStructuredGeneratedImages &&
      !this.hasModeratedGeneratedImages
    )
  }

  snapshotCompletionState(): GatewayTurnCompletionState {
    return {
      upstreamConversationTitle: this.upstreamConversationTitle,
      assistantText: this.assistantText,
      gatewayFinalMessage: this.gatewayFinalMessage,
      collectedWebSearchMeta: this.collectedWebSearchMeta,
      collectedCards: this.collectedCards,
      collectedReasoningEvents: this.collectedReasoningEvents,
      collectedResearch: this.collectedResearch,
      hasStructuredGeneratedImages: this.hasStructuredGeneratedImages,
      hasModeratedGeneratedImages: this.hasModeratedGeneratedImages,
      reasoningStartedAtMs: this.reasoningStartedAtMs,
      reasoningEndedAtMs: this.reasoningEndedAtMs,
    }
  }

  processJsonSegments(segments: string[], nowMs: number): GatewayStreamChunkBatch {
    let chunkDelta = ""
    const chunkReasoningDetails: ChatReasoningEventDetail[] = []

    for (const segment of segments) {
      let parsed: unknown
      try {
        parsed = JSON.parse(segment)
      } catch {
        continue
      }

      const chunkIsThinking = extractChunkIsThinking(parsed)
      if (chunkIsThinking === true) {
        this.wasThinking = true
        if (!this.hasVisibleAssistantDelta && !this.reasoningStartedAtMs) {
          this.reasoningStartedAtMs = nowMs
          this.reasoningEndedAtMs = null
        }
      } else if (chunkIsThinking === false && this.wasThinking && this.pendingToolUsageCardIds.size > 0) {
        for (const id of this.pendingToolUsageCardIds) {
          chunkReasoningDetails.push({
            kind: "tool_result",
            result: { toolUsageCardId: id, isThinking: false },
          })
        }
        this.pendingToolUsageCardIds.clear()
        this.wasThinking = false
        if (this.reasoningStartedAtMs && !this.reasoningEndedAtMs) {
          this.reasoningEndedAtMs = nowMs
        }
      }

      const reasoningEvents = extractReasoningEventsFromRawChunk(parsed)
      for (const detail of reasoningEvents) {
        if (detail.kind === "tool_usage") {
          this.pendingToolUsageCardIds.add(detail.usage.toolUsageCardId)
        }
        if (detail.kind === "tool_result" && detail.result.toolUsageCardId) {
          this.pendingToolUsageCardIds.delete(detail.result.toolUsageCardId)
        }
        if (!this.hasVisibleAssistantDelta && !this.reasoningStartedAtMs) {
          this.reasoningStartedAtMs = nowMs
          this.reasoningEndedAtMs = null
        }
        chunkReasoningDetails.push(detail)
      }

      const nextResponseId = extractGatewayResponseIdFromRawChunk(parsed)
      if (nextResponseId) {
        this.gatewayResponseId = nextResponseId
      }

      const nextFinalMessage = extractGatewayFinalMessageFromRawChunk(parsed)
      if (nextFinalMessage) {
        this.gatewayFinalMessage = nextFinalMessage
      }

      const nextTitle = extractResponseNewTitleFromRawChunk(parsed)
      if (nextTitle) {
        this.upstreamConversationTitle = nextTitle
      }

      this.appendWebSearchMeta(extractWebSearchToolMetaFromRawChunk(parsed))
      this.appendCards(extractCardAttachmentsFromRawChunk(parsed))
      this.collectedResearch = mergeResearchPayload(
        this.collectedResearch,
        extractDeepSearchResearchFromRawChunk(parsed)
      )
      if (extractGeneratedImageModeratedFromRawChunk(parsed)) {
        this.hasModeratedGeneratedImages = true
      }

      const delta = extractGatewayTextDeltaFromRawChunk(parsed)
      if (delta && !this.hasStructuredGeneratedImages && !isGeneratedImageNarration(delta)) {
        this.assistantText += delta
        chunkDelta += delta
      }
    }

    this.collectedReasoningEvents.push(...chunkReasoningDetails)
    if (chunkDelta && !this.hasVisibleAssistantDelta && chunkDelta.trim()) {
      this.hasVisibleAssistantDelta = true
      if (this.reasoningStartedAtMs && !this.reasoningEndedAtMs) {
        this.reasoningEndedAtMs = nowMs
      }
    }

    return {
      delta: chunkDelta,
      reasoningDetails: chunkReasoningDetails,
      responseId: this.gatewayResponseId,
    }
  }

  private appendWebSearchMeta(items: WebSearchToolMeta[]): void {
    for (const item of items) {
      const dedupeKey = `${item.query}\u0000${item.numResults}`
      if (this.collectedWebSearchSeen.has(dedupeKey)) {
        continue
      }
      this.collectedWebSearchSeen.add(dedupeKey)
      this.collectedWebSearchMeta.push(item)
    }
  }

  private appendCards(items: ChatCardAttachmentPayload[]): void {
    for (const item of items) {
      const isGeneratedImage = (item.type || "").toLowerCase() === "generated_image"
      const sourceBeforeNormalize = (item.image?.original || item.url || "").trim()
      const inferredAssetId = inferGeneratedImageAssetId(sourceBeforeNormalize)
      const inferredLocalAssetId = isLocalRenewableImageAssetId(inferredAssetId)
        ? inferredAssetId
        : undefined
      const itemMeta = readCardAssetMeta(item)
      const normalizedItem =
        isGeneratedImage && !itemMeta.asset_id && inferredLocalAssetId
          ? withCardAssetMeta(item, {
              asset_id: inferredLocalAssetId,
            })
          : item
      let canonicalGeneratedKey = ""
      let nextIsPart = false
      const normalizedMeta = readCardAssetMeta(normalizedItem)
      const generatedAssetId = isGeneratedImage
        ? normalizedMeta.asset_id || inferredLocalAssetId || normalizedMeta.assetId || inferredAssetId
        : ""
      if (isGeneratedImage) {
        this.hasStructuredGeneratedImages = true
        const canonical = canonicalizeGeneratedImagePath(sourceBeforeNormalize)
        canonicalGeneratedKey = canonical.key
        nextIsPart = canonical.isPart
      }

      const normalized = normalizeCardAttachmentUrls(normalizedItem, this.apiUrl)
      if (isGeneratedImage && generatedAssetId) {
        const existingByAssetIndex = this.generatedImageIndexByAssetId.get(generatedAssetId)
        if (
          typeof existingByAssetIndex === "number" &&
          existingByAssetIndex >= 0 &&
          existingByAssetIndex < this.collectedCards.length
        ) {
          const existing = this.collectedCards[existingByAssetIndex]
          const preferred = preferGeneratedCardByUrlQuality(existing, normalized, this.apiUrl)
          if (preferred.id !== existing.id && this.collectedCardIds.has(preferred.id)) {
            continue
          }
          this.collectedCardIds.delete(existing.id)
          this.collectedCardIds.add(preferred.id)
          this.collectedCards[existingByAssetIndex] = preferred
          if (canonicalGeneratedKey) {
            this.generatedImageIndexByCanonical.set(canonicalGeneratedKey, existingByAssetIndex)
          }
          this.generatedImageIndexByAssetId.set(generatedAssetId, existingByAssetIndex)
          continue
        }
      }

      if (isGeneratedImage && canonicalGeneratedKey) {
        const existingIndex = this.generatedImageIndexByCanonical.get(canonicalGeneratedKey)
        if (typeof existingIndex === "number" && existingIndex >= 0 && existingIndex < this.collectedCards.length) {
          const existing = this.collectedCards[existingIndex]
          const existingSource = (existing.image?.original || existing.url || "").trim()
          const existingIsPart = canonicalizeGeneratedImagePath(existingSource).isPart
          if (existingIsPart && !nextIsPart) {
            if (existing.id !== normalized.id && this.collectedCardIds.has(normalized.id)) {
              continue
            }
            this.collectedCardIds.delete(existing.id)
            this.collectedCardIds.add(normalized.id)
            this.collectedCards[existingIndex] = normalized
            if (generatedAssetId) {
              this.generatedImageIndexByAssetId.set(generatedAssetId, existingIndex)
            }
          }
          continue
        }
      }
      if (this.collectedCardIds.has(normalized.id)) {
        continue
      }
      this.collectedCardIds.add(normalized.id)
      this.collectedCards.push(normalized)
      if (isGeneratedImage && canonicalGeneratedKey) {
        this.generatedImageIndexByCanonical.set(canonicalGeneratedKey, this.collectedCards.length - 1)
      }
      if (isGeneratedImage && generatedAssetId) {
        this.generatedImageIndexByAssetId.set(generatedAssetId, this.collectedCards.length - 1)
      }
    }
  }
}
