import type { AppConfig } from "../../app/contracts"
import { logClientError } from "../../app/client-log"
import type {
  VoiceService,
  VoiceSessionEventInput,
  VoiceTokenRequest,
  VoiceTokenResult,
} from "../../domain/voice/service"
import { createRuntimeFetch } from "../http/runtime-fetch"

interface GatewayErrorPayload {
  error?:
    | {
        message?: string
      }
    | string
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "")
}

function normalizeVoiceGatewayBaseUrl(input: string): string {
  const trimmed = trimSlash(input.trim())
  if (!trimmed) {
    return "http://localhost:8787"
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed.slice(0, -"/v1/responses".length)
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length)
  }
  if (trimmed.endsWith("/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  return trimmed
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `request failed with status ${response.status}`
  const raw = await response.text().catch(() => "")
  if (!raw.trim()) {
    return fallback
  }
  try {
    const payload = JSON.parse(raw) as GatewayErrorPayload
    const errorPayload = payload.error
    if (typeof errorPayload === "string" && errorPayload.trim()) {
      return errorPayload.trim()
    }
    if (
      errorPayload &&
      typeof errorPayload === "object" &&
      typeof errorPayload.message === "string" &&
      errorPayload.message.trim()
    ) {
      return errorPayload.message.trim()
    }
    return raw.trim() || fallback
  } catch {
    return raw.trim() || fallback
  }
}

function shouldRetryWithoutSession(message: string, input: VoiceTokenRequest): boolean {
  return (
    Boolean(input.sessionId?.trim()) &&
    Boolean(input.conversationId?.trim()) &&
    message.toLowerCase().includes("unknown session_id")
  )
}

export class GatewayVoiceService implements VoiceService {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly runtimeFetch: typeof fetch

  constructor(config: AppConfig) {
    this.baseUrl = normalizeVoiceGatewayBaseUrl(config.apiBaseUrl)
    this.apiKey = config.apiKey
    this.runtimeFetch = createRuntimeFetch(fetch)
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  async issueToken(input: VoiceTokenRequest): Promise<VoiceTokenResult> {
    const personality = input.personality === null ? null : (input.personality || "").trim() || null
    const url = `${this.baseUrl}/api/v1/voice/token`
    try {
      const sendIssueToken = async (requestInput: VoiceTokenRequest): Promise<Response> =>
        this.runtimeFetch(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            voice: requestInput.voice,
            personality,
            speed: requestInput.speed,
            session_id: requestInput.sessionId,
            conversation_id: requestInput.conversationId,
            strict_resume: requestInput.strictResume,
            voice_gateway_session_id: requestInput.voiceGatewaySessionId,
            stateful: true,
          }),
        })

      let effectiveInput = input
      let response = await sendIssueToken(effectiveInput)

      if (!response.ok) {
        const message = await readErrorMessage(response)
        if (response.status === 400 && shouldRetryWithoutSession(message, effectiveInput)) {
          effectiveInput = {
            ...effectiveInput,
            sessionId: undefined,
            strictResume: true,
          }
          response = await sendIssueToken(effectiveInput)
          if (!response.ok) {
            const retryMessage = await readErrorMessage(response)
            throw new Error(retryMessage)
          }
        } else {
          throw new Error(message)
        }
      }

      const payload = (await response.json()) as {
        token: string
        url: string
        room_name: string
        participant_name: string
        session_id?: string
        request_id?: string
        conversation_id?: string
      }

      return {
        token: payload.token,
        url: payload.url,
        roomName: payload.room_name,
        participantName: payload.participant_name,
        sessionId: payload.session_id || effectiveInput.sessionId || "",
        requestId: payload.request_id,
        conversationId: payload.conversation_id || effectiveInput.conversationId,
      }
    } catch (error) {
      void logClientError("voice.issue_token", error, {
        url,
        sessionId: input.sessionId || "",
        conversationId: input.conversationId || "",
        voiceGatewaySessionId: input.voiceGatewaySessionId || "",
      })
      throw error
    }
  }

  async reportSessionEvent(input: VoiceSessionEventInput): Promise<void> {
    const url = `${this.baseUrl}/api/v1/voice/session-events`
    try {
      const response = await this.runtimeFetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          event_id: input.eventId,
          event_type: input.eventType,
          event_time_ms: input.eventTimeMs,
          session_id: input.sessionId,
          conversation_id: input.conversationId,
          response_id: input.responseId,
          request_id: input.requestId,
          voice_gateway_session_id: input.voiceGatewaySessionId,
          voice_gateway_leg_id: input.voiceGatewayLegId,
          livekit_room: input.livekitRoom,
          end_reason: input.endReason,
          ws_close_code: input.wsCloseCode,
          ws_close_text: input.wsCloseText,
          error: input.error,
        }),
      })

      if (!response.ok) {
        const message = await readErrorMessage(response)
        throw new Error(message)
      }
    } catch (error) {
      void logClientError("voice.session_event", error, {
        url,
        sessionId: input.sessionId,
        eventType: input.eventType,
        voiceGatewaySessionId: input.voiceGatewaySessionId || "",
      })
      throw error
    }
  }
}
