import { isRecord } from "./chunk-parsers-common-records"

export function normalizeResponseIdCandidate(input: unknown): string {
  if (typeof input !== "string") {
    return ""
  }
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed
  }
  if (/^resp[_-]/i.test(trimmed)) {
    return trimmed
  }
  return ""
}

export function readExplicitResponseId(value: Record<string, unknown>): string {
  const direct =
    normalizeResponseIdCandidate(value.responseId) || normalizeResponseIdCandidate(value.response_id)
  if (direct) {
    return direct
  }

  if (isRecord(value.modelResponse)) {
    const nested = readExplicitResponseId(value.modelResponse)
    if (nested) {
      return nested
    }
  }

  return ""
}

export function extractResponseIdFromRecord(value: Record<string, unknown>): string {
  const direct = readExplicitResponseId(value)
  if (direct) {
    return direct
  }

  if (isRecord(value.response)) {
    const nestedResponseId = readExplicitResponseId(value.response)
    if (nestedResponseId) {
      return nestedResponseId
    }
  }

  if (isRecord(value.metadata)) {
    const metadataResponseId = readExplicitResponseId(value.metadata)
    if (metadataResponseId) {
      return metadataResponseId
    }
  }

  return ""
}

export function readAssistantResponseIdFromGatewayResponse(value: Record<string, unknown>): string {
  if (isRecord(value.modelResponse)) {
    const modelResponseId = readExplicitResponseId(value.modelResponse)
    if (modelResponseId) {
      return modelResponseId
    }
  }

  if (isRecord(value.userResponse)) {
    return ""
  }

  return readExplicitResponseId(value)
}

function isInternalRelayRecord(value: Record<string, unknown>): boolean {
  const hasRoutingKey =
    typeof value.to === "string" ||
    typeof value.from === "string" ||
    typeof value.sender === "string" ||
    typeof value.receiver === "string" ||
    typeof value.recipient === "string" ||
    typeof value.rolloutId === "string" ||
    typeof value.rollout_id === "string"
  if (!hasRoutingKey) {
    return false
  }
  return typeof value.message === "string" || typeof value.content === "string"
}

export function isInternalGatewayJsonToken(value: string): boolean {
  const trimmed = value.trim()
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return false
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) {
      return false
    }
    if (isInternalRelayRecord(parsed)) {
      return true
    }

    const toolSignalKeys = [
      "query",
      "q",
      "num_results",
      "number_of_images",
      "image_description",
      "instructions",
      "toolUsageCardId",
    ]
    return toolSignalKeys.some((key) => key in parsed)
  } catch {
    return false
  }
}
