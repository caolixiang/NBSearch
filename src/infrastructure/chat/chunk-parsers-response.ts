import {
  isInternalGatewayJsonToken,
  isRecord,
  normalizeResponseIdCandidate,
  parseRecords,
  readAssistantResponseIdFromGatewayResponse,
  readExplicitResponseId,
  collectRawChunkCandidates,
} from "./chunk-parsers-common"

export function extractGatewayTextDeltaFromRawChunk(rawChunk: unknown): string {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (candidate.type === "response.output_text.delta" && typeof candidate.delta === "string") {
      return candidate.delta
    }

    if (typeof candidate.delta === "string") {
      return candidate.delta
    }

    if (typeof candidate.token !== "string") {
      continue
    }

    const messageTag = typeof candidate.messageTag === "string" ? candidate.messageTag.trim().toLowerCase() : ""
    if (messageTag === "header" || messageTag === "tool_usage_card" || messageTag === "raw_function_result") {
      continue
    }
    if (typeof candidate.isThinking === "boolean" && candidate.isThinking && messageTag !== "final") {
      continue
    }
    if (isInternalGatewayJsonToken(candidate.token)) {
      continue
    }
    return candidate.token
  }

  return ""
}

function extractTextFromOutputMessage(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return ""
  }

  const chunks: string[] = []
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
        continue
      }
      chunks.push(part.text)
    }
  }
  return chunks.join("")
}

export function extractGatewayFinalMessageFromRawChunk(rawChunk: unknown): string {
  for (const candidate of collectRawChunkCandidates(rawChunk)) {
    if (candidate.type === "response.output_text.done" && typeof candidate.text === "string") {
      return candidate.text
    }

    if (candidate.type === "response.completed") {
      const completedText = extractTextFromOutputMessage(candidate.response)
      if (completedText) {
        return completedText
      }
    }

    const outputText = extractTextFromOutputMessage(candidate)
    if (outputText) {
      return outputText
    }

    if (
      typeof candidate.message === "string" &&
      candidate.message.trim() &&
      !(typeof candidate.sender === "string" && candidate.sender.toLowerCase() === "human") &&
      !isInternalGatewayJsonToken(candidate.message)
    ) {
      return candidate.message
    }
  }

  return ""
}

export function extractGatewayResponseIdFromRawChunk(rawChunk: unknown): string {
  for (const parsed of parseRecords(rawChunk)) {
    const topLevelResponseId =
      normalizeResponseIdCandidate(parsed.response_id) || normalizeResponseIdCandidate(parsed.responseId)
    if (topLevelResponseId) {
      return topLevelResponseId
    }

    const eventType = typeof parsed.type === "string" ? parsed.type.trim() : ""
    if ((eventType === "response.created" || eventType === "response.completed") && isRecord(parsed.response)) {
      const responseObjectId = normalizeResponseIdCandidate(parsed.response.id)
      if (responseObjectId) {
        return responseObjectId
      }
    }

    if (isRecord(parsed.response)) {
      const rootResponseId = readAssistantResponseIdFromGatewayResponse(parsed.response)
      if (rootResponseId) {
        return rootResponseId
      }
    }

    if (isRecord(parsed.result)) {
      if (isRecord(parsed.result.response)) {
        const wrappedResponseId = readAssistantResponseIdFromGatewayResponse(parsed.result.response)
        if (wrappedResponseId) {
          return wrappedResponseId
        }
      }
      if (isRecord(parsed.result.modelResponse)) {
        const wrappedModelResponseId = readExplicitResponseId(parsed.result.modelResponse)
        if (wrappedModelResponseId) {
          return wrappedModelResponseId
        }
      }
    }
  }

  return ""
}
