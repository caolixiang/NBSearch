export type VoiceSessionEventType =
  | "session_connected"
  | "conversation_started"
  | "conversation_bound"
  | "anchor_updated"
  | "session_failed"
  | "session_closed"
  | "session_expired"

export type VoiceSessionEndReason =
  | "manual_close"
  | "api_close"
  | "network_drop"
  | "idle_timeout"
  | "server_shutdown"
  | "upstream_error"

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
  conversationId?: string
  voice?: string
  personality?: string | null
  speed?: number
  strictResume?: boolean
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
  itemId?: string
  eventId?: string
  voiceEventKey?: string
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
  endReason?: VoiceSessionEndReason
  wsCloseCode?: number
  wsCloseText?: string
  error?: string
}

export interface VoiceService {
  issueToken(input: VoiceTokenRequest): Promise<VoiceTokenResult>

  reportSessionEvent(input: VoiceSessionEventInput): Promise<void>
}
