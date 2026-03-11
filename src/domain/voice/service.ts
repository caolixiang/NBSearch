export type VoiceSessionEventType =
  | "session_connected"
  | "conversation_started"
  | "conversation_bound"
  | "anchor_updated"
  | "session_failed"
  | "session_closed"
  | "session_expired"

export type VoiceTextEventRole = "user" | "assistant"

export interface VoiceSessionSettings {
  voice: string
  personality: string | null
  instructions: string
  isRawInstructions: boolean
  speed: number
}

export interface VoiceTokenRequest {
  sessionId?: string
  voice?: string
  personality?: string | null
  speed?: number
  voiceGatewaySessionId?: string
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

export interface VoiceTextEvent {
  role: VoiceTextEventRole
  text: string
  final: boolean
  topic: string
  responseId?: string
  conversationId?: string
  source?: string
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
