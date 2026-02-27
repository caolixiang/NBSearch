import { Room, RoomEvent } from "livekit-client"
import type { VoiceService, VoiceTokenRequest } from "../../domain/voice/service"

export interface LivekitSessionLifecycle {
  onConnected?: (sessionId: string) => void
  onDisconnected?: (sessionId: string) => void
  onError?: (sessionId: string, error: string) => void
}

function newEventId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}

export class LivekitSessionController {
  private room: Room | null = null
  private sessionId = ""
  private requestId = ""
  private conversationId = ""
  private roomName = ""

  constructor(
    private readonly voiceService: VoiceService,
    private readonly lifecycle: LivekitSessionLifecycle = {}
  ) {}

  async connect(input: VoiceTokenRequest): Promise<void> {
    const token = await this.voiceService.issueToken(input)
    this.sessionId = token.sessionId
    this.requestId = token.requestId || ""
    this.conversationId = token.conversationId || ""
    this.roomName = token.roomName

    const room = new Room()
    this.room = room

    room.on(RoomEvent.Connected, () => {
      this.lifecycle.onConnected?.(this.sessionId)
      void this.voiceService.reportSessionEvent({
        eventId: newEventId("evt_connected"),
        eventType: "session_connected",
        eventTimeMs: Date.now(),
        sessionId: this.sessionId,
        requestId: this.requestId || undefined,
        conversationId: this.conversationId || undefined,
        livekitRoom: this.roomName || undefined,
      })
    })

    room.on(RoomEvent.Disconnected, () => {
      this.lifecycle.onDisconnected?.(this.sessionId)
      void this.voiceService.reportSessionEvent({
        eventId: newEventId("evt_closed"),
        eventType: "session_closed",
        eventTimeMs: Date.now(),
        sessionId: this.sessionId,
        requestId: this.requestId || undefined,
        conversationId: this.conversationId || undefined,
        livekitRoom: this.roomName || undefined,
        endReason: "manual_close",
      })
    })

    room.on(RoomEvent.MediaDevicesError, (error) => {
      const message = error instanceof Error ? error.message : "media_device_error"
      this.lifecycle.onError?.(this.sessionId, message)
      void this.voiceService.reportSessionEvent({
        eventId: newEventId("evt_failed"),
        eventType: "session_failed",
        eventTimeMs: Date.now(),
        sessionId: this.sessionId,
        requestId: this.requestId || undefined,
        conversationId: this.conversationId || undefined,
        livekitRoom: this.roomName || undefined,
        error: message,
      })
    })

    await room.connect(token.url, token.token)
  }

  async disconnect(): Promise<void> {
    if (!this.room) {
      return
    }
    await this.room.disconnect()
    this.room = null
  }
}
