import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import { collectRawChunkCandidates, isRecord } from "./chunk-parsers-common"
import { collectCardAttachmentsFromEnvelope } from "./chunk-parsers-card-attachment-payload"
import { readGeneratedImageModeratedFlag } from "./chunk-parsers-generated-image-attachments"

export function extractGeneratedImageModeratedFromRawChunk(rawChunk: unknown): boolean {
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return false
  }

  for (const candidate of candidates) {
    if (readGeneratedImageModeratedFlag(candidate)) {
      return true
    }

    const streamingImageGeneration = isRecord(candidate.streamingImageGenerationResponse)
      ? candidate.streamingImageGenerationResponse
      : null
    if (streamingImageGeneration && readGeneratedImageModeratedFlag(streamingImageGeneration)) {
      return true
    }

    const arraysToCheck: unknown[][] = []
    if (Array.isArray(candidate.generatedImageUrls)) {
      arraysToCheck.push(candidate.generatedImageUrls)
    }
    if (Array.isArray(candidate.data)) {
      arraysToCheck.push(candidate.data)
    }
    if (isRecord(candidate.image_generation) && Array.isArray(candidate.image_generation.data)) {
      arraysToCheck.push(candidate.image_generation.data)
    }
    if (isRecord(candidate.modelResponse) && Array.isArray(candidate.modelResponse.generatedImageUrls)) {
      arraysToCheck.push(candidate.modelResponse.generatedImageUrls)
    }
    for (const list of arraysToCheck) {
      for (const item of list) {
        if (readGeneratedImageModeratedFlag(item)) {
          return true
        }
      }
    }
  }

  return false
}

export function extractCardAttachmentsFromRawChunk(rawChunk: unknown): ChatCardAttachmentPayload[] {
  const candidates = collectRawChunkCandidates(rawChunk)
  if (candidates.length === 0) {
    return []
  }

  const cards: ChatCardAttachmentPayload[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const eventType = typeof candidate.type === "string" ? candidate.type.trim() : ""
    const dropGeneratedImageCard = eventType === "response.output_item.added"
    for (const card of collectCardAttachmentsFromEnvelope(candidate, { dropGeneratedImageCard })) {
      if (seen.has(card.id)) {
        continue
      }
      seen.add(card.id)
      cards.push(card)
    }
  }

  return cards
}
