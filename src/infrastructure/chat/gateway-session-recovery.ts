import type { ChatMessage } from "../../domain/chat/types"
import { isRecord } from "./chunk-parsers"

export type GatewayTurnStatus = "not_found" | "in_progress" | "completed" | "failed"

export type GatewayTurnState = {
  status: GatewayTurnStatus
  responseId: string
  errorCode: string
  errorMessage: string
  updatedAt: number
}

export type GatewaySessionState = {
  sessionId: string
  lastResponseId: string
  inProgress: boolean
  activeClientTurnId: string
  updatedAt: number
}

export type GatewaySessionMessage = {
  id: string
  responseId: string
  previousResponseId: string
  role: ChatMessage["role"]
  content: string
  status: "streaming" | "completed" | "failed"
  createdAt: number
  clientTurnId: string
}

export type GatewaySessionRecoveryClient = {
  queryTurnState: (sessionId: string, clientTurnId: string) => Promise<GatewayTurnState | null>
  querySessionState: (sessionId: string) => Promise<GatewaySessionState | null>
  querySessionMessages: (sessionId: string, afterResponseId: string) => Promise<GatewaySessionMessage[]>
}

type GatewaySessionRecoveryClientInput = {
  gatewayBaseUrl: string
  runtimeFetch: typeof fetch
  createAuthHeaders: (extra?: Record<string, string>) => Record<string, string>
  turnRecoveryMessagesLimit: number
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeGatewayTurnStatus(value: unknown): GatewayTurnStatus {
  const normalized = readTrimmedString(value).toLowerCase()
  if (
    normalized === "not_found" ||
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "failed"
  ) {
    return normalized
  }
  return "not_found"
}

function readSafeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return 0
}

function readRecoveryMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item)
        continue
      }
      if (!isRecord(item)) {
        continue
      }
      const inlineText = readTrimmedString(item.text)
      if (inlineText) {
        parts.push(inlineText)
      }
      if (Array.isArray(item.content)) {
        for (const row of item.content) {
          if (!isRecord(row)) {
            continue
          }
          const rowText = readTrimmedString(row.text)
          if (rowText) {
            parts.push(rowText)
          }
        }
      }
    }
    return parts.join("\n").trim()
  }
  if (isRecord(value)) {
    const direct = readTrimmedString(value.text) || readTrimmedString(value.content)
    if (direct) {
      return direct
    }
    if (Array.isArray(value.content)) {
      const rows = value.content
        .map((item) => (isRecord(item) ? readTrimmedString(item.text) : ""))
        .filter(Boolean)
      return rows.join("\n").trim()
    }
  }
  return ""
}

function readResponseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

function buildGatewayRecoveryUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`
  return `${baseUrl}${normalizedPath}`
}

function readJsonErrorCode(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return ""
  }
  return readTrimmedString(payload.error.code)
}

export function normalizeTurnRecoverySetting(
  value: unknown,
  fallback: number,
  max: number
): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.min(max, Math.floor(value))
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(max, parsed)
    }
  }
  return fallback
}

export function coerceGatewayTurnState(payload: unknown): GatewayTurnState | null {
  const root = isRecord(payload) ? payload : null
  const candidates = [
    root,
    root && isRecord(root.data) ? root.data : null,
    root && isRecord(root.result) ? root.result : null,
    root && isRecord(root.turn) ? root.turn : null,
  ].filter((item): item is Record<string, unknown> => Boolean(item))

  for (const candidate of candidates) {
    const status = normalizeGatewayTurnStatus(candidate.status)
    const responseId = readTrimmedString(candidate.response_id) || readTrimmedString(candidate.responseId)
    const updatedAt = readSafeInteger(candidate.updated_at ?? candidate.updatedAt)
    const errorRecord = isRecord(candidate.error) ? candidate.error : null
    const errorCode = errorRecord ? readTrimmedString(errorRecord.code) : ""
    const errorMessage = errorRecord ? readTrimmedString(errorRecord.message) : ""
    if (status || responseId || updatedAt > 0 || errorCode || errorMessage) {
      return {
        status,
        responseId,
        errorCode,
        errorMessage,
        updatedAt,
      }
    }
  }

  return null
}

export function coerceGatewaySessionState(payload: unknown): GatewaySessionState | null {
  const root = isRecord(payload) ? payload : null
  const candidates = [
    root,
    root && isRecord(root.data) ? root.data : null,
    root && isRecord(root.result) ? root.result : null,
    root && isRecord(root.session) ? root.session : null,
  ].filter((item): item is Record<string, unknown> => Boolean(item))

  for (const candidate of candidates) {
    const sessionId = readTrimmedString(candidate.session_id) || readTrimmedString(candidate.sessionId)
    const lastResponseId =
      readTrimmedString(candidate.last_response_id) || readTrimmedString(candidate.lastResponseId)
    const inProgress =
      candidate.in_progress === true ||
      candidate.inProgress === true ||
      candidate.status === "in_progress"
    const activeClientTurnId =
      readTrimmedString(candidate.active_client_turn_id) ||
      readTrimmedString(candidate.activeClientTurnId)
    const updatedAt = readSafeInteger(candidate.updated_at ?? candidate.updatedAt)
    if (sessionId || lastResponseId || inProgress || activeClientTurnId || updatedAt > 0) {
      return {
        sessionId,
        lastResponseId,
        inProgress,
        activeClientTurnId,
        updatedAt,
      }
    }
  }

  return null
}

export function coerceGatewaySessionMessages(payload: unknown): GatewaySessionMessage[] {
  const root = isRecord(payload) ? payload : null
  const messagesCandidate =
    (root && Array.isArray(root.messages) ? root.messages : null) ||
    (root && isRecord(root.data) && Array.isArray(root.data.messages) ? root.data.messages : null) ||
    (root && isRecord(root.result) && Array.isArray(root.result.messages) ? root.result.messages : null)
  if (!messagesCandidate) {
    return []
  }

  const rows: GatewaySessionMessage[] = []
  for (const item of messagesCandidate) {
    if (!isRecord(item)) {
      continue
    }
    const roleRaw = readTrimmedString(item.role).toLowerCase()
    if (roleRaw !== "user" && roleRaw !== "assistant" && roleRaw !== "system" && roleRaw !== "tool") {
      continue
    }
    const statusRaw = readTrimmedString(item.status).toLowerCase()
    const status: "streaming" | "completed" | "failed" =
      statusRaw === "failed"
        ? "failed"
        : statusRaw === "streaming" || statusRaw === "in_progress"
          ? "streaming"
          : "completed"
    const responseId = readTrimmedString(item.response_id) || readTrimmedString(item.responseId)
    const id = readTrimmedString(item.id) || responseId || `msg_${crypto.randomUUID()}`
    const content =
      readRecoveryMessageContent(item.content) ||
      readRecoveryMessageContent(item.message) ||
      readRecoveryMessageContent(item.output)
    rows.push({
      id,
      responseId,
      previousResponseId:
        readTrimmedString(item.previous_response_id) || readTrimmedString(item.previousResponseId),
      role: roleRaw as ChatMessage["role"],
      content,
      status,
      createdAt: readSafeInteger(item.created_at ?? item.createdAt) || Date.now(),
      clientTurnId:
        readTrimmedString(item.client_turn_id) || readTrimmedString(item.clientTurnId),
    })
  }

  return rows
}

export class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`stream_idle_timeout_${timeoutMs}ms`)
    this.name = "StreamIdleTimeoutError"
  }
}

export async function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeoutHandle)
      cleanup()
      reject(new Error("aborted"))
    }
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort)
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

export function createGatewaySessionRecoveryClient(
  input: GatewaySessionRecoveryClientInput
): GatewaySessionRecoveryClient {
  const querySessionMessages = async (
    sessionId: string,
    afterResponseId: string
  ): Promise<GatewaySessionMessage[]> => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) {
      return []
    }
    const url = new URL(
      buildGatewayRecoveryUrl(input.gatewayBaseUrl, `/sessions/${encodeURIComponent(normalizedSessionId)}/messages`)
    )
    if (afterResponseId.trim()) {
      url.searchParams.set("after_response_id", afterResponseId.trim())
    }
    url.searchParams.set("limit", String(input.turnRecoveryMessagesLimit))

    try {
      const response = await input.runtimeFetch(url.toString(), {
        method: "GET",
        headers: input.createAuthHeaders(),
      })
      if (!response.ok) {
        if (afterResponseId.trim()) {
          const contentType = (response.headers.get("content-type") || "").toLowerCase()
          if (contentType.includes("json")) {
            const payload = await readResponseJson(response)
            if (readJsonErrorCode(payload) === "invalid_after_response_id") {
              return querySessionMessages(normalizedSessionId, "")
            }
          }
        }
        return []
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase()
      if (!contentType.includes("json")) {
        return []
      }
      const payload = await readResponseJson(response)
      return coerceGatewaySessionMessages(payload)
    } catch {
      return []
    }
  }

  return {
    async queryTurnState(sessionId: string, clientTurnId: string): Promise<GatewayTurnState | null> {
      const normalizedSessionId = sessionId.trim()
      const normalizedClientTurnId = clientTurnId.trim()
      if (!normalizedSessionId || !normalizedClientTurnId) {
        return null
      }
      const url = buildGatewayRecoveryUrl(
        input.gatewayBaseUrl,
        `/sessions/${encodeURIComponent(normalizedSessionId)}/turns/${encodeURIComponent(normalizedClientTurnId)}`
      )
      try {
        const response = await input.runtimeFetch(url, {
          method: "GET",
          headers: input.createAuthHeaders(),
        })
        if (!response.ok) {
          return null
        }
        const contentType = (response.headers.get("content-type") || "").toLowerCase()
        if (!contentType.includes("json")) {
          return null
        }
        const payload = await readResponseJson(response)
        return coerceGatewayTurnState(payload)
      } catch {
        return null
      }
    },

    async querySessionState(sessionId: string): Promise<GatewaySessionState | null> {
      const normalizedSessionId = sessionId.trim()
      if (!normalizedSessionId) {
        return null
      }
      const url = buildGatewayRecoveryUrl(
        input.gatewayBaseUrl,
        `/sessions/${encodeURIComponent(normalizedSessionId)}/state`
      )
      try {
        const response = await input.runtimeFetch(url, {
          method: "GET",
          headers: input.createAuthHeaders(),
        })
        if (!response.ok) {
          return null
        }
        const contentType = (response.headers.get("content-type") || "").toLowerCase()
        if (!contentType.includes("json")) {
          return null
        }
        const payload = await readResponseJson(response)
        return coerceGatewaySessionState(payload)
      } catch {
        return null
      }
    },

    querySessionMessages,
  }
}
