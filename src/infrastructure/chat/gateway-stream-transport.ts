import type { ChatReasoningEventDetail, ChatTurnResult } from "../../domain/chat/types"
import { isRecord, parseJsonObjectStrings } from "./chunk-parsers"
import { GatewayStreamAccumulator, readReasoningEventResponseId } from "./gateway-stream-accumulator"
import { StreamIdleTimeoutError, waitForRetryDelay } from "./gateway-session-recovery"
import type { GatewayTurnRecoveryOutcome } from "./gateway-turn-recovery"

const STREAM_HEARTBEAT_INTERVAL_MS = 2000
const ANCHOR_RECOVERY_ERROR_CODES = new Set(["session_anchor_conflict", "invalid_previous_response_id"])
const TURN_RECOVERY_HTTP_RETRYABLE_CODES = new Set([
  "session_in_progress",
  "turn_in_progress",
  "network_timeout",
])

export type GatewayStreamTransportOutcome =
  | {
      kind: "stream_finished"
      gatewayResponseId: string
    }
  | {
      kind: "completed"
      gatewayResponseId: string
      result: ChatTurnResult
    }
  | {
      kind: "failed"
      gatewayResponseId: string
      code: string
      message: string
    }

type GatewayStreamTransportInput = {
  apiUrl: string
  runtimeFetch: typeof fetch
  createAuthHeaders: (extra?: Record<string, string>) => Record<string, string>
  clientTurnId: string
  requestBodyPayload: Record<string, unknown>
  accumulator: GatewayStreamAccumulator
  isRegenerate: boolean
  signal?: AbortSignal
  streamIdleTimeoutMs: number
  streamIdleRetryMaxAttempts: number
  streamIdleRetryDelayMs: number
  turnRecoveryNotFoundRetryMaxAttempts: number
  turnInProgressRetryMaxAttempts: number
  turnInProgressRetryDelayMs: number
  emitDelta: (textDelta: string, responseId?: string) => void
  emitReasoning: (detail: ChatReasoningEventDetail, responseId?: string) => void
  emitHeartbeat: (idleMs: number, responseId?: string) => void
  attemptTurnRecovery: (allowRetryFromNotFound: boolean) => Promise<GatewayTurnRecoveryOutcome>
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

type RecoveryDecision =
  | {
      kind: "continue"
    }
  | GatewayStreamTransportOutcome
  | {
      kind: "none"
    }

function extractGatewayErrorCode(errorText: string): string {
  const raw = errorText.trim()
  if (!raw) {
    return ""
  }
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !isRecord(parsed.error)) {
      return ""
    }
    const code = typeof parsed.error.code === "string" ? parsed.error.code.trim() : ""
    return code || ""
  } catch {
    return ""
  }
}

async function readChunkWithTimeout(input: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  streamIdleTimeoutMs: number
}): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new StreamIdleTimeoutError(input.streamIdleTimeoutMs))
    }, input.streamIdleTimeoutMs)
  })
  try {
    return await Promise.race([input.reader.read(), timeoutPromise])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

async function consumeGatewayStreamBody(input: {
  response: Response
  accumulator: GatewayStreamAccumulator
  gatewayResponseId: string
  streamIdleTimeoutMs: number
  emitDelta: (textDelta: string, responseId?: string) => void
  emitReasoning: (detail: ChatReasoningEventDetail, responseId?: string) => void
  emitHeartbeat: (idleMs: number, responseId?: string) => void
}): Promise<{
  gatewayResponseId: string
}> {
  const reader = input.response.body?.getReader()
  if (!reader) {
    throw new Error("Response has no body")
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let lastChunkAt = Date.now()
  let lastHeartbeatSentAt = 0
  let gatewayResponseId = input.gatewayResponseId

  try {
    while (true) {
      const { done, value } = await readChunkWithTimeout({
        reader,
        streamIdleTimeoutMs: input.streamIdleTimeoutMs,
      })
      if (done) {
        break
      }

      const chunkArrivedAt = Date.now()
      const idleMs = Math.max(0, chunkArrivedAt - lastChunkAt)
      if (lastHeartbeatSentAt === 0 || chunkArrivedAt - lastHeartbeatSentAt >= STREAM_HEARTBEAT_INTERVAL_MS) {
        input.emitHeartbeat(idleMs, gatewayResponseId)
        lastHeartbeatSentAt = chunkArrivedAt
      }
      lastChunkAt = chunkArrivedAt

      buffer += decoder.decode(value, { stream: true })
      const segments = parseJsonObjectStrings(buffer)
      if (segments.length === 0) {
        continue
      }

      let lastEnd = 0
      for (const segment of segments) {
        const idx = buffer.indexOf(segment, lastEnd)
        if (idx >= 0) {
          lastEnd = idx + segment.length
        }
      }
      buffer = buffer.slice(lastEnd)

      const processedChunk = input.accumulator.processJsonSegments(segments, chunkArrivedAt)
      if (processedChunk.responseId) {
        gatewayResponseId = processedChunk.responseId
      }
      for (const detail of processedChunk.reasoningDetails) {
        input.emitReasoning(detail, readReasoningEventResponseId(detail))
      }
      if (processedChunk.delta) {
        input.emitDelta(processedChunk.delta, gatewayResponseId)
      }
    }

    return {
      gatewayResponseId,
    }
  } finally {
    reader.releaseLock()
  }
}

export async function executeGatewayStreamTransport(
  input: GatewayStreamTransportInput
): Promise<GatewayStreamTransportOutcome> {
  let gatewayResponseId = ""
  let idleRetryAttempts = 0
  let anchorRecoveryAttempts = 0
  let turnNotFoundRetryAttempts = 0
  let turnInProgressRetryAttempts = 0
  const wait = input.wait || waitForRetryDelay

  const resolveRecovery = async (allowRetryFromNotFound: boolean, allowInProgressRetry: boolean): Promise<RecoveryDecision> => {
    if (input.isRegenerate) {
      return { kind: "none" }
    }
    const recovery = await input.attemptTurnRecovery(allowRetryFromNotFound)
    if (recovery.kind === "completed") {
      return {
        kind: "completed",
        gatewayResponseId,
        result: recovery.result,
      }
    }
    if (
      recovery.kind === "retry_send" &&
      allowRetryFromNotFound &&
      turnNotFoundRetryAttempts < input.turnRecoveryNotFoundRetryMaxAttempts
    ) {
      turnNotFoundRetryAttempts += 1
      return { kind: "continue" }
    }
    if (recovery.kind === "in_progress") {
      if (allowInProgressRetry && turnInProgressRetryAttempts < input.turnInProgressRetryMaxAttempts) {
        turnInProgressRetryAttempts += 1
        await wait(input.turnInProgressRetryDelayMs, input.signal)
        return { kind: "continue" }
      }
      return {
        kind: "failed",
        gatewayResponseId,
        code: "turn_in_progress",
        message: "turn_is_still_in_progress",
      }
    }
    return { kind: "none" }
  }

  try {
    while (true) {
      const requestBody = JSON.stringify(input.requestBodyPayload)
      let response: Response
      try {
        response = await input.runtimeFetch(input.apiUrl, {
          method: "POST",
          headers: input.createAuthHeaders({
            "Content-Type": "application/json",
            "Idempotency-Key": input.clientTurnId,
          }),
          body: requestBody,
          signal: input.signal,
        })
      } catch (error) {
        const recoveryDecision = await resolveRecovery(
          turnNotFoundRetryAttempts < input.turnRecoveryNotFoundRetryMaxAttempts,
          true
        )
        if (recoveryDecision.kind === "continue") {
          continue
        }
        if (recoveryDecision.kind !== "none") {
          return recoveryDecision
        }
        throw error
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        const errorCode = extractGatewayErrorCode(errorText)
        const currentPreviousResponseId =
          typeof input.requestBodyPayload["previous_response_id"] === "string"
            ? input.requestBodyPayload["previous_response_id"].trim()
            : ""
        const shouldRetryFromAnchorConflict =
          !input.isRegenerate &&
          currentPreviousResponseId.length > 0 &&
          anchorRecoveryAttempts < 1 &&
          ANCHOR_RECOVERY_ERROR_CODES.has(errorCode)
        if (shouldRetryFromAnchorConflict) {
          delete input.requestBodyPayload["previous_response_id"]
          anchorRecoveryAttempts += 1
          continue
        }

        const shouldTrySessionRecovery =
          !input.isRegenerate &&
          (TURN_RECOVERY_HTTP_RETRYABLE_CODES.has(errorCode) ||
            ANCHOR_RECOVERY_ERROR_CODES.has(errorCode) ||
            response.status >= 500 ||
            response.status === 409)
        if (shouldTrySessionRecovery) {
          const recoveryDecision = await resolveRecovery(
            turnNotFoundRetryAttempts < input.turnRecoveryNotFoundRetryMaxAttempts,
            true
          )
          if (recoveryDecision.kind === "continue") {
            continue
          }
          if (recoveryDecision.kind !== "none") {
            return recoveryDecision
          }
        }

        return {
          kind: "failed",
          gatewayResponseId,
          code: `http_${response.status}`,
          message: errorText || `HTTP ${response.status}`,
        }
      }

      if (!response.body) {
        const recoveryDecision = await resolveRecovery(
          turnNotFoundRetryAttempts < input.turnRecoveryNotFoundRetryMaxAttempts,
          true
        )
        if (recoveryDecision.kind === "continue") {
          continue
        }
        if (recoveryDecision.kind !== "none") {
          return recoveryDecision
        }
        return {
          kind: "failed",
          gatewayResponseId,
          code: "no_body",
          message: "Response has no body",
        }
      }

      try {
        const consumed = await consumeGatewayStreamBody({
          response,
          accumulator: input.accumulator,
          gatewayResponseId,
          streamIdleTimeoutMs: input.streamIdleTimeoutMs,
          emitDelta: input.emitDelta,
          emitReasoning: input.emitReasoning,
          emitHeartbeat: input.emitHeartbeat,
        })
        gatewayResponseId = consumed.gatewayResponseId
        return {
          kind: "stream_finished",
          gatewayResponseId,
        }
      } catch (error) {
        const shouldRetryFromIdleTimeout =
          error instanceof StreamIdleTimeoutError &&
          idleRetryAttempts < input.streamIdleRetryMaxAttempts &&
          input.accumulator.shouldRetryIdleTimeout()
        if (shouldRetryFromIdleTimeout) {
          idleRetryAttempts += 1
          await wait(input.streamIdleRetryDelayMs, input.signal)
          continue
        }

        const recoveryDecision = await resolveRecovery(
          turnNotFoundRetryAttempts < input.turnRecoveryNotFoundRetryMaxAttempts,
          true
        )
        if (recoveryDecision.kind === "continue") {
          continue
        }
        if (recoveryDecision.kind !== "none") {
          return recoveryDecision
        }
        throw error
      }
    }
  } catch (error) {
    const recoveryDecision = await resolveRecovery(false, false)
    if (recoveryDecision.kind !== "none" && recoveryDecision.kind !== "continue") {
      return recoveryDecision
    }
    if (error instanceof StreamIdleTimeoutError) {
      return {
        kind: "failed",
        gatewayResponseId,
        code: "stream_idle_timeout",
        message: error.message,
      }
    }
    return {
      kind: "failed",
      gatewayResponseId,
      code: "chat_stream_error",
      message: error instanceof Error ? error.message : "unknown_error",
    }
  }
}
