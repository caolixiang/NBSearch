import {
  type ChatMessage as LivekitChatMessage,
  createAudioAnalyser,
  type LocalParticipant,
  type LocalTrackPublication,
  type Participant,
  Room,
  RoomEvent,
  Track,
  type TranscriptionSegment,
} from "livekit-client"
import { logClientError } from "../../app/client-log"
import type {
  VoiceService,
  VoiceSessionEndReason,
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
  conversationId?: string
  settings: VoiceSessionSettings
}

export interface LivekitSessionLifecycle {
  onIssued?: (snapshot: LivekitSessionSnapshot) => void
  onConnected?: (snapshot: LivekitSessionSnapshot) => void
  onDisconnected?: (snapshot: LivekitSessionSnapshot) => void
  onError?: (snapshot: LivekitSessionSnapshot, error: string) => void
  onTextEvent?: (snapshot: LivekitSessionSnapshot, event: VoiceTextEvent) => void
  onMicLevel?: (snapshot: LivekitSessionSnapshot, level: number) => void
}

interface VoiceAudioAnalyser {
  calculateVolume: () => number
  cleanup: () => Promise<void> | void
}

export interface LivekitSessionControllerDeps {
  createRoom?: () => Room
  createAudioAnalyser?: (track: NonNullable<LocalTrackPublication["audioTrack"]>) => VoiceAudioAnalyser
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

const DEFAULT_CAPTURE_OPTIONS = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
} as const
const MIC_LEVEL_SAMPLE_MS = 96

const REMOTE_AUDIO_HOST_DATASET_KEY = "livekitVoiceAudioHost"

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

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

export async function requestVoiceMediaAccess(): Promise<void> {
  const mediaDevices = globalThis.navigator?.mediaDevices
  if (!mediaDevices?.getUserMedia) {
    throw new Error("microphone access unavailable")
  }
  const stream = await mediaDevices.getUserMedia({
    audio: DEFAULT_CAPTURE_OPTIONS,
  })
  try {
    if (stream.getAudioTracks().length === 0) {
      throw new Error("no audio device")
    }
  } finally {
    stopMediaStream(stream)
  }
}

export class LivekitSessionController {
  private room: Room | null = null
  private snapshot: LivekitSessionSnapshot = createInitialSnapshot()
  private disconnectReason: VoiceSessionEndReason = "network_drop"
  private reportedConversationStarted = false
  private reportedConversationId = ""
  private reportedResponseId = ""
  private canonicalAssistantResponseId = ""
  private recentTextKeys = new Map<string, number>()
  private readonly textDecoder = new TextDecoder()
  private remoteAudioHost: HTMLDivElement | null = null
  private disconnecting = false
  private failingSession = false
  private micLevelTimer: ReturnType<typeof globalThis.setInterval> | null = null
  private micLevelCleanup: (() => Promise<void> | void) | null = null

  constructor(
    private readonly voiceService: VoiceService,
    private readonly lifecycle: LivekitSessionLifecycle = {},
    private readonly deps: LivekitSessionControllerDeps = {}
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

  private rememberCanonicalAssistantResponseId(responseId?: string): void {
    const normalizedResponseId = responseId?.trim() || ""
    if (!normalizedResponseId) {
      return
    }
    this.canonicalAssistantResponseId = normalizedResponseId
  }

  private normalizeVoiceTextEvent(event: VoiceTextEvent): VoiceTextEvent {
    if (event.role !== "assistant") {
      return event
    }

    const source = event.source?.trim() || ""
    const responseId = event.responseId?.trim() || ""

    if (
      source === "response.audio_transcript.delta" ||
      source === "response.audio_transcript.done" ||
      source === "response.text.delta" ||
      source === "response.text.final" ||
      source === "response.text.done" ||
      source === "response.grok.output"
    ) {
      this.rememberCanonicalAssistantResponseId(responseId)
      return event
    }

    if (source === "response.human_assist_turn.commit") {
      const canonicalResponseId = this.canonicalAssistantResponseId || responseId
      if (!canonicalResponseId) {
        return event
      }
      return {
        ...event,
        responseId: canonicalResponseId,
        voiceEventKey: `assistant:resp:${canonicalResponseId}`,
      }
    }

    this.rememberCanonicalAssistantResponseId(responseId)
    return event
  }

  private emitMicLevel(level: number): void {
    const normalizedLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
    this.lifecycle.onMicLevel?.(this.getSnapshot(), normalizedLevel)
  }

  private stopMicLevelMonitoring(resetLevel = true): void {
    const clearIntervalFn = this.deps.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    if (this.micLevelTimer !== null) {
      clearIntervalFn(this.micLevelTimer)
      this.micLevelTimer = null
    }
    const cleanup = this.micLevelCleanup
    this.micLevelCleanup = null
    if (cleanup) {
      void Promise.resolve(cleanup()).catch((error) => {
        void logClientError("voice.mic_level_cleanup", error, {
          sessionId: this.snapshot.sessionId,
          roomName: this.snapshot.roomName,
        })
      })
    }
    if (resetLevel) {
      this.emitMicLevel(0)
    }
  }

  private startMicLevelMonitoring(publication?: LocalTrackPublication): void {
    this.stopMicLevelMonitoring(false)
    const audioTrack = publication?.audioTrack
    if (!audioTrack) {
      this.emitMicLevel(0)
      return
    }
    try {
      const analyserFactory = this.deps.createAudioAnalyser ?? createAudioAnalyser
      const analyser = analyserFactory(audioTrack)
      this.micLevelCleanup = analyser.cleanup
      const setIntervalFn = this.deps.setInterval ?? globalThis.setInterval.bind(globalThis)
      const sampleLevel = () => {
        const rawLevel = analyser.calculateVolume()
        const boostedLevel = Number.isFinite(rawLevel) ? Math.max(0, Math.min(1, rawLevel * 2.8)) : 0
        this.emitMicLevel(boostedLevel)
      }
      sampleLevel()
      this.micLevelTimer = setIntervalFn(sampleLevel, MIC_LEVEL_SAMPLE_MS)
    } catch (error) {
      this.emitMicLevel(0)
      void logClientError("voice.mic_level", error, {
        sessionId: this.snapshot.sessionId,
        roomName: this.snapshot.roomName,
      })
    }
  }

  private async emitTextEvent(event: VoiceTextEvent): Promise<void> {
    const normalizedEvent = this.normalizeVoiceTextEvent(event)
    const normalizedConversationId = normalizedEvent.conversationId?.trim() || ""
    if (normalizedConversationId && normalizedConversationId !== this.snapshot.conversationId) {
      this.setSnapshot({ conversationId: normalizedConversationId })
      await this.reportConversationBound(normalizedConversationId)
    } else if (normalizedConversationId) {
      await this.reportConversationBound(normalizedConversationId)
    }

    if (!this.shouldEmitTextEvent(normalizedEvent)) {
      return
    }

    if (normalizedEvent.role === "assistant" && normalizedEvent.final) {
      await this.reportConversationStarted(normalizedEvent.responseId)
      if (normalizedEvent.responseId?.trim()) {
        await this.reportAnchorUpdated(normalizedEvent.responseId)
      }
    }

    this.lifecycle.onTextEvent?.(this.getSnapshot(), normalizedEvent)
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

  private ensureRemoteAudioHost(): HTMLDivElement | null {
    if (typeof document === "undefined") {
      return null
    }
    if (this.remoteAudioHost?.isConnected) {
      return this.remoteAudioHost
    }
    const host = document.createElement("div")
    host.dataset[REMOTE_AUDIO_HOST_DATASET_KEY] = "true"
    host.hidden = true
    host.style.position = "fixed"
    host.style.width = "0"
    host.style.height = "0"
    host.style.overflow = "hidden"
    host.style.pointerEvents = "none"
    document.body.appendChild(host)
    this.remoteAudioHost = host
    return host
  }

  private cleanupRemoteAudioHost(): void {
    if (!this.remoteAudioHost) {
      return
    }
    this.remoteAudioHost.replaceChildren()
    this.remoteAudioHost.remove()
    this.remoteAudioHost = null
  }

  private attachRemoteAudioTrack(track: { attach: () => HTMLMediaElement }, participant?: Participant): void {
    const element = track.attach()
    element.autoplay = true
    element.muted = false
    element.setAttribute("playsinline", "true")
    const host = this.ensureRemoteAudioHost()
    host?.appendChild(element)
    if (participant) {
      this.applySpeakerMutedToParticipant(participant)
    }
  }

  private detachRemoteTrackElements(track: { detach: () => HTMLMediaElement | HTMLMediaElement[] }): void {
    const detached = track.detach()
    const elements = Array.isArray(detached) ? detached : [detached]
    for (const element of elements) {
      element.remove()
    }
  }

  private async failSession(message: string, closeReason: VoiceSessionEndReason): Promise<void> {
    if (this.failingSession) {
      return
    }
    this.failingSession = true
    await this.reportSessionEvent({
      eventType: "session_failed",
      sessionId: this.snapshot.sessionId,
      conversationId: this.snapshot.conversationId || undefined,
      requestId: this.snapshot.requestId || undefined,
      voiceGatewaySessionId: this.snapshot.voiceGatewaySessionId || undefined,
      livekitRoom: this.snapshot.roomName || undefined,
      voiceGatewayLegId: this.snapshot.legId || undefined,
      error: message,
    })
    try {
      this.lifecycle.onError?.(this.getSnapshot(), message)
      await this.disconnect(closeReason)
    } finally {
      this.failingSession = false
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

    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Audio && participant.identity !== room.localParticipant.identity) {
        this.attachRemoteAudioTrack(track, participant)
        void room.startAudio().catch((error) => {
          void logClientError("voice.audio_playback", error, {
            sessionId: this.snapshot.sessionId,
            roomName: this.snapshot.roomName,
            participantIdentity: participant.identity,
          })
        })
        return
      }
      this.applySpeakerMutedToParticipant(participant)
    })

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        this.detachRemoteTrackElements(track)
      }
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
        if (envelope.responseCreatedId) {
          this.rememberCanonicalAssistantResponseId(envelope.responseCreatedId)
        }
        if (envelope.conversationId) {
          void this.reportConversationBound(envelope.conversationId)
        }
        for (const event of envelope.textEvents) {
          void this.emitTextEvent(event)
        }
      }
    )

    room.on(RoomEvent.Disconnected, () => {
      this.cleanupRemoteAudioHost()
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
      void this.failSession(message, "api_close")
    })
  }

  async connect(input: LivekitConnectInput): Promise<LivekitSessionSnapshot> {
    if (this.room) {
      await this.disconnect()
    }
    this.stopMicLevelMonitoring(false)

    const settings = {
      ...input.settings,
      voice: input.settings.voice.trim(),
      personality: input.settings.personality?.trim() || null,
      instructions: input.settings.instructions.trim(),
    }
    this.reportedConversationStarted = false
    this.reportedConversationId = ""
    this.reportedResponseId = ""
    this.canonicalAssistantResponseId = ""
    this.recentTextKeys.clear()
    this.failingSession = false
    const voiceGatewaySessionId = `vgs_${crypto.randomUUID().replaceAll("-", "")}`

    const tokenInput: VoiceTokenRequest = {
      sessionId: input.sessionId?.trim() || undefined,
      conversationId: input.conversationId?.trim() || undefined,
      voice: settings.voice,
      personality: settings.instructions ? null : settings.personality,
      speed: settings.speed,
      strictResume: Boolean(input.conversationId?.trim()),
      voiceGatewaySessionId,
    }

    const token = await this.voiceService.issueToken(tokenInput)
    const issuedSnapshot = this.setSnapshot({
      sessionId: token.sessionId,
      requestId: token.requestId || "",
      conversationId: token.conversationId || input.conversationId?.trim() || "",
      roomName: token.roomName || "",
      legId: `leg_${crypto.randomUUID().replaceAll("-", "")}`,
      voiceGatewaySessionId,
      connected: false,
      micMuted: false,
      speakerMuted: false,
      settings,
    })
    this.lifecycle.onIssued?.(issuedSnapshot)

    const room = this.deps.createRoom?.() ?? new Room()
    this.room = room
    this.attachRoomListeners(room)

    try {
      await room.connect(token.url, token.token)
      const microphonePublication = await room.localParticipant.setMicrophoneEnabled(true, DEFAULT_CAPTURE_OPTIONS)
      this.startMicLevelMonitoring(microphonePublication)
      await room.startAudio().catch((error) => {
        void logClientError("voice.audio_playback", error, {
          sessionId: this.snapshot.sessionId,
          roomName: this.snapshot.roomName,
        })
      })
      this.applySpeakerMutedToRoom()
      if (settings.instructions || settings.isRawInstructions) {
        await this.updateSettings(settings)
      }
      return this.getSnapshot()
    } catch (error) {
      const message = readErrorMessage(error)
      this.setSnapshot({
        sessionId: this.snapshot.sessionId || token.sessionId,
        requestId: this.snapshot.requestId || token.requestId || "",
        conversationId: this.snapshot.conversationId || token.conversationId || "",
        roomName: this.snapshot.roomName || token.roomName || "",
        voiceGatewaySessionId: voiceGatewaySessionId,
      })
      await this.failSession(message, "api_close")
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
      this.emitMicLevel(0)
      return
    }
    const publication = await room.localParticipant.setMicrophoneEnabled(!muted, DEFAULT_CAPTURE_OPTIONS)
    if (muted) {
      this.stopMicLevelMonitoring()
    } else {
      this.startMicLevelMonitoring(publication)
    }
    this.setSnapshot({ micMuted: muted })
  }

  async setSpeakerMuted(muted: boolean): Promise<void> {
    this.setSnapshot({ speakerMuted: muted })
    this.applySpeakerMutedToRoom()
  }

  async disconnect(endReason: VoiceSessionEndReason = "manual_close"): Promise<void> {
    if (this.disconnecting) {
      return
    }
    if (!this.room) {
      this.stopMicLevelMonitoring()
      this.cleanupRemoteAudioHost()
      this.setSnapshot({ connected: false })
      return
    }
    this.disconnecting = true
    const room = this.room
    this.room = null
    this.disconnectReason = endReason
    try {
      this.stopMicLevelMonitoring()
      await room.disconnect()
    } finally {
      this.cleanupRemoteAudioHost()
      this.disconnecting = false
    }
  }
}
