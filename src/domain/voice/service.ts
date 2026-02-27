export type VoiceSessionEventType =
  | "session_connected"
  | "conversation_started"
  | "conversation_bound"
  | "anchor_updated"
  | "session_failed"
  | "session_closed"
  | "session_expired"

export interface VoiceTokenRequest {
  sessionId?: string
  conversationId?: string
  strictResume?: boolean
  voice?: string
  personality?: string
  speed?: number
}

export interface VoiceTokenResult {
  token: string
  url: string
  roomName: string
  participantName: string
  sessionId: string
  requestId?: string
  conversationId?: string
}

export interface VoiceSessionEventInput {
  eventId: string
  eventType: VoiceSessionEventType
  eventTimeMs: number
  sessionId: string
  conversationId?: string
  responseId?: string
  requestId?: string
  voiceGatewaySessionId?: string
  voiceGatewayLegId?: string
  livekitRoom?: string
  endReason?: string
  wsCloseCode?: number
  wsCloseText?: string
  error?: string
}

export interface VoiceService {
  issueToken(input: VoiceTokenRequest): Promise<VoiceTokenResult>

  reportSessionEvent(input: VoiceSessionEventInput): Promise<void>
}
