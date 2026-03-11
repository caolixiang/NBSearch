import type { AppConfig } from "../../app/contracts"
import type {
  VoiceService,
  VoiceSessionEventInput,
  VoiceTokenRequest,
  VoiceTokenResult,
} from "../../domain/voice/service"

interface GatewayErrorPayload {
  error?: {
    message?: string
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "")
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `request failed with status ${response.status}`
  try {
    const payload = (await response.json()) as GatewayErrorPayload
    return payload.error?.message?.trim() || fallback
  } catch {
    return fallback
  }
}

export class GatewayVoiceService implements VoiceService {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(config: AppConfig) {
    this.baseUrl = trimSlash(config.apiBaseUrl)
    this.apiKey = config.apiKey
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  async issueToken(input: VoiceTokenRequest): Promise<VoiceTokenResult> {
    const personality = input.personality === null ? null : (input.personality || "").trim() || null
    const response = await fetch(`${this.baseUrl}/api/v1/voice/token`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        voice: input.voice,
        personality,
        speed: input.speed,
        session_id: input.sessionId,
        voice_gateway_session_id: input.voiceGatewaySessionId,
        stateful: true,
      }),
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
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
      sessionId: payload.session_id || input.sessionId || "",
      requestId: payload.request_id,
      conversationId: payload.conversation_id,
    }
  }

  async reportSessionEvent(input: VoiceSessionEventInput): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/v1/voice/session-events`, {
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
      throw new Error(await readErrorMessage(response))
    }
  }
}
