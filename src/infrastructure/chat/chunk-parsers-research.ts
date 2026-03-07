import type { ChatCitationCard, ChatDeepSearchResearch } from "../../domain/chat/types"
import { collectRawChunkCandidates, isRecord } from "./chunk-parsers-common"
import { extractCardAttachmentsFromRawChunk } from "./chunk-parsers-card-attachments"
import {
  extractInlineCitationsFromText,
  toCitationCardFromAttachment,
} from "./chunk-parsers-research-citations"
import {
  hasResearchFragment,
  mergeResearchFragments,
  parseResearchDetailsFromSteps,
  parseResearchObject,
  parseResearchStepFromMessageTag,
} from "./chunk-parsers-research-fragments"

export { extractInlineCitationsFromText } from "./chunk-parsers-research-citations"

export function extractDeepSearchResearchFromRawChunk(rawChunk: unknown): Partial<ChatDeepSearchResearch> {
  let merged: Partial<ChatDeepSearchResearch> = {}

  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    const fromXGrok =
      isRecord(candidate.x_grok) && isRecord(candidate.x_grok.research)
        ? parseResearchObject(candidate.x_grok.research)
        : {}
    if (hasResearchFragment(fromXGrok)) {
      merged = mergeResearchFragments(merged, fromXGrok)
    }

    const fromResearch = parseResearchObject(candidate.research)
    if (hasResearchFragment(fromResearch)) {
      merged = mergeResearchFragments(merged, fromResearch)
    }

    const fromModelResponse = isRecord(candidate.modelResponse) ? parseResearchObject(candidate.modelResponse) : {}
    if (hasResearchFragment(fromModelResponse)) {
      merged = mergeResearchFragments(merged, fromModelResponse)
    }

    const fromCandidate = parseResearchObject(candidate)
    if (hasResearchFragment(fromCandidate)) {
      merged = mergeResearchFragments(merged, fromCandidate)
    }

    const stepFromMessageTag = parseResearchStepFromMessageTag(candidate)
    if (stepFromMessageTag) {
      merged = mergeResearchFragments(merged, {
        steps: [stepFromMessageTag],
        details: parseResearchDetailsFromSteps([stepFromMessageTag]),
      })
    }
  }

  const citationCards = extractCardAttachmentsFromRawChunk(rawChunk)
    .map((card) => toCitationCardFromAttachment(card))
    .filter((row): row is ChatCitationCard => Boolean(row))
  if (citationCards.length > 0) {
    merged = mergeResearchFragments(merged, { citationCards })
  }

  return merged
}
