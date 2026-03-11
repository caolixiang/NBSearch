import {
  type ChatMessage as LivekitChatMessage,
  type LocalParticipant,
  type Participant,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from "livekit-client"
import type {
  VoiceService,
  VoiceSessionEventInput,
  VoiceSessionSettings,
  VoiceTextEvent,
  VoiceTokenRequest,
} from "../../domain/voice/service"
import {
  LIVEKIT_TOPIC_CHAT,
  LIVEKIT_TOPIC_GROK_CHAT,
  LIVEKIT_TOPIC_REALTIME_CLIENT_EVENT,
  LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS,
  LIVEKIT_TOPIC_TRANSCRIPTION,
  buildLivekitChatPayloads,
  buildLivekitSessionUpdatePayload,
  decodeLivekitTextEnvelope,
} from "./livekit-protocol"

export interface LivekitSessionSnapshot {
  sessionId: string
  requestId: string
  conversationId: string
  roomName: string
  legId: string
  voiceGatewaySessionId: string
  connected: boolean
  micMuted: boolean
  speakerMuted: boolean
  settings: VoiceSessionSettings | null
}

export interface LivekitConnectInput {
  sessionId?: string
  settings: VoiceSessionSettings
}

export interface LivekitSessionLifecycle {
  onIssued?: (snapshot: LivekitSessionSnapshot) => void
  onConnected?: (snapshot: LivekitSessionSnapshot) => void
  onDisconnected?: (snapshot: LivekitSessionSnapshot) => void
  onError?: (snapshot: LivekitSessionSnapshot, error: string) => void
  onTextEvent?: (snapshot: LivekitSessionSnapshot, event: VoiceTextEvent) => void
}

const DEFAULT_CAPTURE_OPTIONS = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
} as const

function newEventId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}

function createInitialSnapshot(): LivekitSessionSnapshot {
  return {
    sessionId: "",
    requestId: "",
    conversationId: "",
    roomName: "",
    legId: "",
    voiceGatewaySessionId: "",
    connected: false,
    micMuted: false,
    speakerMuted: false,
    settings: null,
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || "voice_error"
  }
  if (typeof error === "string") {
    return error.trim() || "voice_error"
  }
  return "voice_error"
}

function normalizeTextForDedup(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

export class LivekitSessionController {
  private room: Room | null = null
  private snapshot: LivekitSessionSnapshot = createInitialSnapshot()
  private disconnectReason = "network_drop"
  private reportedConversationStarted = false
  private reportedConversationId = ""
  private reportedResponseId = ""
  private recentTextKeys = new Map<string, number>()
  private readonly textDecoder = new TextDecoder()

  constructor(
    private readonly voiceService: VoiceService,
    private readonly lifecycle: LivekitSessionLifecycle = {}
  ) {}

  getSnapshot(): LivekitSessionSnapshot {
    return {
      ...this.snapshot,
      settings: this.snapshot.settings ? { ...this.snapshot.settings } : null,
    }
  }

  private setSnapshot(patch: Partial<LivekitSessionSnapshot>): LivekitSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      settings:
        patch.settings !== undefined
          ? patch.settings
            ? { ...patch.settings }
            : null
          : this.snapshot.settings
            ? { ...this.snapshot.settings }
            : null,
    }
    return this.getSnapshot()
  }

  private async reportSessionEvent(input: Omit<VoiceSessionEventInput, "eventId" | "eventTimeMs">): Promise<void> {
    try {
      await this.voiceService.reportSessionEvent({
        eventId: newEventId("evt_voice"),
        eventTimeMs: Date.now(),
        ...input,
      })
    } catch {
      // Session-event reporting is best-effort on the client side.
    }
  }

  private async reportConversationBound(conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId || !this.snapshot.sessionId || this.reportedConversationId === normalizedConversationId) {
      return
    }
    this.reportedConversationId = normalizedConversationId
    await this.reportSessionEvent({
      eventType: "conversation_bound",
      sessionId: this.snapshot.sessionId,
      conversationId: normalizedConversationId,
      requestId: this.snapshot.requestId || undefined,
      voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
      livekitRoom: this.snapshot.roomName || undefined,
      voiceGatewayLegId: this.snapshot.legId || undefined,
    })
  }

  private async reportConversationStarted(responseId?: string): Promise<void> {
    if (this.reportedConversationStarted || !this.snapshot.sessionId) {
      return
    }
    this.reportedConversationStarted = true
    await this.reportSessionEvent({
      eventType: "conversation_started",
      sessionId: this.snapshot.sessionId,
      conversationId: this.snapshot.conversationId || undefined,
      responseId: responseId?.trim() || undefined,
      requestId: this.snapshot.requestId || undefined,
      voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
      livekitRoom: this.snapshot.roomName || undefined,
      voiceGatewayLegId: this.snapshot.legId || undefined,
    })
  }

  private async reportAnchorUpdated(responseId: string): Promise<void> {
    const normalizedResponseId = responseId.trim()
    if (!normalizedResponseId || !this.snapshot.sessionId || this.reportedResponseId === normalizedResponseId) {
      return
    }
    this.reportedResponseId = normalizedResponseId
    await this.reportSessionEvent({
      eventType: "anchor_updated",
      sessionId: this.snapshot.sessionId,
      conversationId: this.snapshot.conversationId || undefined,
      responseId: normalizedResponseId,
      requestId: this.snapshot.requestId || undefined,
      voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
      livekitRoom: this.snapshot.roomName || undefined,
      voiceGatewayLegId: this.snapshot.legId || undefined,
    })
  }

  private shouldEmitTextEvent(event: VoiceTextEvent): boolean {
    if (!event.final) {
      return true
    }
    const normalizedText = normalizeTextForDedup(event.text)
    if (!normalizedText) {
      return false
    }
    const key = `${event.role}|${event.responseId || ""}|${normalizedText}`
    const now = Date.now()
    for (const [candidate, at] of this.recentTextKeys.entries()) {
      if (now - at > 15_000) {
        this.recentTextKeys.delete(candidate)
      }
    }
    const previous = this.recentTextKeys.get(key)
    if (previous && now - previous <= 15_000) {
      return false
    }
    this.recentTextKeys.set(key, now)
    return true
  }

  private async emitTextEvent(event: VoiceTextEvent): Promise<void> {
    const normalizedConversationId = event.conversationId?.trim() || ""
    if (normalizedConversationId && normalizedConversationId !== this.snapshot.conversationId) {
      this.setSnapshot({ conversationId: normalizedConversationId })
      await this.reportConversationBound(normalizedConversationId)
    } else if (normalizedConversationId) {
      await this.reportConversationBound(normalizedConversationId)
    }

    if (event.role === "assistant" && event.final) {
      await this.reportConversationStarted(event.responseId)
      if (event.responseId?.trim()) {
        await this.reportAnchorUpdated(event.responseId)
      }
    }

    if (!this.shouldEmitTextEvent(event)) {
      return
    }
    this.lifecycle.onTextEvent?.(this.getSnapshot(), event)
  }

  private applySpeakerMutedToParticipant(participant: Participant | undefined): void {
    if (!participant || participant.identity === this.room?.localParticipant.identity) {
      return
    }
    if ("setVolume" in participant && typeof participant.setVolume === "function") {
      const volume = this.snapshot.speakerMuted ? 0 : 1
      participant.setVolume(volume, Track.Source.Microphone)
    }
  }

  private applySpeakerMutedToRoom(): void {
    if (!this.room) {
      return
    }
    for (const participant of this.room.remoteParticipants.values()) {
      this.applySpeakerMutedToParticipant(participant)
    }
  }

  private attachRoomListeners(room: Room): void {
    room.on(RoomEvent.Connected, () => {
      this.setSnapshot({
        connected: true,
      })
      void this.reportSessionEvent({
        eventType: "session_connected",
        sessionId: this.snapshot.sessionId,
        conversationId: this.snapshot.conversationId || undefined,
        requestId: this.snapshot.requestId || undefined,
        voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
        livekitRoom: this.snapshot.roomName || undefined,
        voiceGatewayLegId: this.snapshot.legId || undefined,
      })
      if (this.snapshot.conversationId) {
        void this.reportConversationBound(this.snapshot.conversationId)
      }
      this.lifecycle.onConnected?.(this.getSnapshot())
    })

    room.on(RoomEvent.TrackSubscribed, (_track, _publication, participant) => {
      this.applySpeakerMutedToParticipant(participant)
    })

    room.on(RoomEvent.ChatMessage, (message: LivekitChatMessage, participant?: Participant | LocalParticipant) => {
      const text = message.message.trim()
      if (!text) {
        return
      }
      const role = participant?.identity === room.localParticipant.identity ? "user" : "assistant"
      void this.emitTextEvent({
        role,
        text,
        final: true,
        topic: LIVEKIT_TOPIC_CHAT,
        source: "livekit.chatMessage",
      })
    })

    room.on(
      RoomEvent.TranscriptionReceived,
      (segments: TranscriptionSegment[], participant?: Participant) => {
        const parts = segments
          .map((segment) => segment.text.trim())
          .filter((segment) => segment.length > 0)
        if (parts.length === 0) {
          return
        }
        const role = participant?.identity === room.localParticipant.identity ? "user" : "assistant"
        void this.emitTextEvent({
          role,
          text: parts.join(" "),
          final: segments.every((segment) => segment.final),
          topic: LIVEKIT_TOPIC_TRANSCRIPTION,
          source: "livekit.transcription",
        })
      }
    )

    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
        const rawText = this.textDecoder.decode(payload).trim()
        if (!rawText) {
          return
        }
        const envelope = decodeLivekitTextEnvelope({
          rawText,
          topic,
          participantIdentity: participant?.identity,
          localParticipantIdentity: room.localParticipant.identity,
        })
        if (envelope.conversationId) {
          void this.reportConversationBound(envelope.conversationId)
        }
        for (const event of envelope.textEvents) {
          void this.emitTextEvent(event)
        }
      }
    )

    room.on(RoomEvent.Disconnected, () => {
      const closedSnapshot = this.setSnapshot({
        connected: false,
      })
      const endReason = this.disconnectReason
      this.disconnectReason = "network_drop"
      void this.reportSessionEvent({
        eventType: "session_closed",
        sessionId: this.snapshot.sessionId,
        conversationId: this.snapshot.conversationId || undefined,
        requestId: this.snapshot.requestId || undefined,
        voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
        livekitRoom: this.snapshot.roomName || undefined,
        voiceGatewayLegId: this.snapshot.legId || undefined,
        endReason,
      })
      this.lifecycle.onDisconnected?.(closedSnapshot)
    })

    room.on(RoomEvent.MediaDevicesError, (error) => {
      const message = readErrorMessage(error)
      void this.reportSessionEvent({
        eventType: "session_failed",
        sessionId: this.snapshot.sessionId,
        conversationId: this.snapshot.conversationId || undefined,
        requestId: this.snapshot.requestId || undefined,
        voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
        livekitRoom: this.snapshot.roomName || undefined,
        voiceGatewayLegId: this.snapshot.legId || undefined,
        error: message,
      })
      this.lifecycle.onError?.(this.getSnapshot(), message)
    })
  }

  async connect(input: LivekitConnectInput): Promise<LivekitSessionSnapshot> {
    if (this.room) {
      await this.disconnect()
    }

    const settings = {
      ...input.settings,
      voice: input.settings.voice.trim(),
      personality: input.settings.personality?.trim() || null,
      instructions: input.settings.instructions.trim(),
    }
    this.reportedConversationStarted = false
    this.reportedConversationId = ""
    this.reportedResponseId = ""
    this.recentTextKeys.clear()
    const voiceGatewaySessionId = `vgs_${crypto.randomUUID().replaceAll("-", "")}`

    const tokenInput: VoiceTokenRequest = {
      sessionId: input.sessionId?.trim() || undefined,
      voice: settings.voice,
      personality: settings.instructions ? null : settings.personality,
      speed: settings.speed,
      voiceGatewaySessionId,
    }

    const token = await this.voiceService.issueToken(tokenInput)
    const issuedSnapshot = this.setSnapshot({
      sessionId: token.sessionId,
      requestId: token.requestId || "",
      conversationId: token.conversationId || "",
      roomName: token.roomName || "",
      legId: `leg_${crypto.randomUUID().replaceAll("-", "")}`,
      voiceGatewaySessionId,
      connected: false,
      micMuted: false,
      speakerMuted: false,
      settings,
    })
    this.lifecycle.onIssued?.(issuedSnapshot)

    const room = new Room()
    this.room = room
    this.attachRoomListeners(room)

    try {
      await room.connect(token.url, token.token)
      await room.localParticipant.setMicrophoneEnabled(true, DEFAULT_CAPTURE_OPTIONS)
      await room.startAudio().catch(() => undefined)
      this.applySpeakerMutedToRoom()
      if (settings.instructions || settings.isRawInstructions) {
        await this.updateSettings(settings)
      }
      return this.getSnapshot()
    } catch (error) {
      const message = readErrorMessage(error)
      void this.reportSessionEvent({
        eventType: "session_failed",
        sessionId: this.snapshot.sessionId || token.sessionId,
        conversationId: this.snapshot.conversationId || token.conversationId || undefined,
        requestId: this.snapshot.requestId || token.requestId || undefined,
        voiceGatewaySessionId: voiceGatewaySessionId || undefined,
        livekitRoom: this.snapshot.roomName || token.roomName || undefined,
        voiceGatewayLegId: this.snapshot.legId || undefined,
        error: message,
      })
      this.lifecycle.onError?.(this.getSnapshot(), message)
      throw error
    }
  }

  async updateSettings(nextSettings: VoiceSessionSettings): Promise<void> {
    const normalizedSettings: VoiceSessionSettings = {
      ...nextSettings,
      voice: nextSettings.voice.trim(),
      personality: nextSettings.personality?.trim() || null,
      instructions: nextSettings.instructions.trim(),
    }
    this.setSnapshot({ settings: normalizedSettings })

    if (!this.room) {
      return
    }

    const payload = buildLivekitSessionUpdatePayload(normalizedSettings)
    try {
      await this.room.localParticipant.publishData(payload, {
        reliable: true,
        topic: LIVEKIT_TOPIC_REALTIME_CLIENT_EVENT,
      })
    } catch {
      await this.room.localParticipant.publishData(payload, {
        reliable: false,
        topic: LIVEKIT_TOPIC_REALTIME_CLIENT_EVENT,
      })
    }
  }

  async sendText(text: string): Promise<void> {
    const normalizedText = text.trim()
    if (!normalizedText) {
      return
    }
    if (!this.room) {
      throw new Error("voice session is not connected")
    }

    const attempts = await Promise.allSettled([
      this.room.localParticipant.sendChatMessage(normalizedText),
      ...buildLivekitChatPayloads(normalizedText).map((packet) =>
        this.room!.localParticipant.publishData(packet.payload, {
          reliable: packet.reliable,
          topic: packet.topic,
        })
      ),
    ])
    if (attempts.every((attempt) => attempt.status === "rejected")) {
      throw new Error("send_voice_text_failed")
    }
  }

  async setMicrophoneMuted(muted: boolean): Promise<void> {
    const room = this.room
    if (!room) {
      this.setSnapshot({ micMuted: muted })
      return
    }
    await room.localParticipant.setMicrophoneEnabled(!muted, DEFAULT_CAPTURE_OPTIONS)
    this.setSnapshot({ micMuted: muted })
  }

  async setSpeakerMuted(muted: boolean): Promise<void> {
    this.setSnapshot({ speakerMuted: muted })
    this.applySpeakerMutedToRoom()
  }

  async disconnect(endReason = "manual_close"): Promise<void> {
    if (!this.room) {
      this.setSnapshot({ connected: false })
      return
    }
    const room = this.room
    this.room = null
    this.disconnectReason = endReason
    await room.disconnect()
  }
}
