import { afterEach, describe, expect, it, mock } from "bun:test"
import { RoomEvent, Track, type Room as LivekitRoom } from "livekit-client"
import type { VoiceService, VoiceTokenResult } from "../../domain/voice/service"
import { LivekitSessionController, requestVoiceMediaAccess } from "./livekit-session"

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")

class FakeElement {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  parentElement: FakeElement | null = null
  hidden = false
  isConnected = false
  autoplay = false
  muted = false

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this
    child.isConnected = true
    this.children.push(child)
    return child
  }

  replaceChildren(): void {
    for (const child of this.children) {
      child.parentElement = null
      child.isConnected = false
    }
    this.children.splice(0, this.children.length)
  }

  remove(): void {
    if (this.parentElement) {
      const siblings = this.parentElement.children
      const index = siblings.indexOf(this)
      if (index >= 0) {
        siblings.splice(index, 1)
      }
    }
    this.parentElement = null
    this.isConnected = false
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }
}

function createFakeDocument() {
  const body = new FakeElement("body")
  body.isConnected = true
  return {
    body,
    createElement(tagName: string) {
      return new FakeElement(tagName)
    },
  }
}

function setNavigatorMediaDevices(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia,
      },
    },
  })
}

function setFakeDocument() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: createFakeDocument(),
  })
}

function restoreNavigator() {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor)
    return
  }
  Reflect.deleteProperty(globalThis, "navigator")
}

function restoreDocument() {
  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, "document", originalDocumentDescriptor)
    return
  }
  Reflect.deleteProperty(globalThis, "document")
}

class FakeRoom {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  readonly remoteParticipants = new Map<string, { identity: string; setVolume: ReturnType<typeof mock> }>()

  readonly localParticipant: {
    identity: string
    setMicrophoneEnabled: ReturnType<typeof mock>
    publishData: ReturnType<typeof mock>
    sendChatMessage: ReturnType<typeof mock>
  } = {
    identity: "local-participant",
    setMicrophoneEnabled: mock(async () => undefined),
    publishData: mock(async () => undefined),
    sendChatMessage: mock(async () => undefined),
  }

  readonly connect = mock(async () => {
    this.emit(RoomEvent.Connected)
  })

  readonly disconnect = mock(async () => {
    this.emit(RoomEvent.Disconnected)
  })

  readonly startAudio = mock(async () => undefined)

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) || []
    existing.push(handler)
    this.listeners.set(event, existing)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) || []) {
      handler(...args)
    }
  }
}

function createVoiceService(tokenOverrides: Partial<VoiceTokenResult> = {}): VoiceService {
  return {
    issueToken: async () => ({
      token: "voice-token",
      url: "wss://livekit.example.com",
      roomName: "room-voice-1",
      participantName: "participant-voice-1",
      sessionId: "sess-voice-1",
      requestId: "req-voice-1",
      conversationId: "conv-voice-1",
      ...tokenOverrides,
    }),
    reportSessionEvent: async () => undefined,
  }
}

afterEach(() => {
  restoreNavigator()
  restoreDocument()
})

describe("requestVoiceMediaAccess", () => {
  it("requests microphone access and stops temporary tracks", async () => {
    const stop = mock(() => undefined)
    const getUserMedia = mock(async () => ({
      getTracks: () => [{ stop }],
      getAudioTracks: () => [{ stop }],
    } as unknown as MediaStream))
    setNavigatorMediaDevices(getUserMedia)

    await requestVoiceMediaAccess()

    expect(getUserMedia.mock.calls.length).toBe(1)
    expect(stop.mock.calls.length).toBe(1)
  })
})

describe("LivekitSessionController", () => {
  it("attaches and detaches remote audio tracks", async () => {
    setFakeDocument()
    const room = new FakeRoom()
    const controller = new LivekitSessionController(createVoiceService(), {}, {
      createRoom: () => room as unknown as LivekitRoom,
    })

    await controller.connect({
      sessionId: "sess-voice-1",
      settings: {
        voice: "ara",
        personality: "assistant",
        instructions: "",
        isRawInstructions: false,
        speed: 1,
      },
    })

    const audioElement = document.createElement("audio") as unknown as FakeElement
    const attach = mock(() => audioElement)
    const detach = mock(() => [audioElement])
    const participant = {
      identity: "remote-assistant",
      setVolume: mock(() => undefined),
    }
    room.remoteParticipants.set(participant.identity, participant)

    room.emit(
      RoomEvent.TrackSubscribed,
      {
        kind: Track.Kind.Audio,
        attach,
        detach,
      },
      {},
      participant
    )

    const host = (document.body as unknown as FakeElement).children[0]
    expect(host?.children[0]).toBe(audioElement)
    expect(attach.mock.calls.length).toBe(1)
    expect(room.startAudio.mock.calls.length).toBeGreaterThan(0)

    room.emit(
      RoomEvent.TrackUnsubscribed,
      {
        kind: Track.Kind.Audio,
        detach,
      },
      {},
      participant
    )

    expect(detach.mock.calls.length).toBe(1)
    expect(host?.children.length).toBe(0)
  })

  it("disconnects the room when microphone startup fails", async () => {
    const room = new FakeRoom()
    room.localParticipant.setMicrophoneEnabled = mock(async () => {
      throw new Error("NotAllowedError: Permission denied")
    })
    const onError = mock(() => undefined)
    const controller = new LivekitSessionController(
      createVoiceService(),
      {
        onError,
      },
      {
        createRoom: () => room as unknown as LivekitRoom,
      }
    )

    await expect(
      controller.connect({
        sessionId: "sess-voice-1",
        settings: {
          voice: "ara",
          personality: "assistant",
          instructions: "",
          isRawInstructions: false,
          speed: 1,
        },
      })
    ).rejects.toThrow("NotAllowedError: Permission denied")

    expect(room.disconnect.mock.calls.length).toBe(1)
    expect(onError.mock.calls.length).toBe(1)
    expect(controller.getSnapshot().connected).toBe(false)
  })

  it("samples local microphone levels while voice mode is active", async () => {
    const room = new FakeRoom()
    const localAudioTrack = {
      mediaStreamTrack: {},
    }
    room.localParticipant.setMicrophoneEnabled = mock(async () => ({
      audioTrack: localAudioTrack,
    }))
    const onMicLevel = mock((_snapshot: unknown, _level: number) => undefined)
    const timerRef: { current: (() => void) | null } = { current: null }
    const clearIntervalFn = mock(() => undefined)
    const cleanup = mock(() => undefined)
    const calculateVolume = mock(() => 0.24)
    const controller = new LivekitSessionController(
      createVoiceService(),
      {
        onMicLevel,
      },
      {
        createRoom: () => room as unknown as LivekitRoom,
        createAudioAnalyser: () => ({
          calculateVolume,
          cleanup,
        }),
        setInterval: ((handler: () => void) => {
          timerRef.current = handler
          return 1 as unknown as ReturnType<typeof globalThis.setInterval>
        }) as typeof globalThis.setInterval,
        clearInterval: clearIntervalFn as typeof globalThis.clearInterval,
      }
    )

    await controller.connect({
      sessionId: "sess-voice-1",
      settings: {
        voice: "ara",
        personality: "assistant",
        instructions: "",
        isRawInstructions: false,
        speed: 1,
      },
    })

    const micLevelCalls = onMicLevel.mock.calls as Array<[unknown, number]>
    expect(micLevelCalls.length).toBe(1)
    const firstMicLevelCall = micLevelCalls[0]
    expect(firstMicLevelCall?.[1]).toBeGreaterThan(0.6)

    if (timerRef.current) {
      timerRef.current()
    }
    expect(calculateVolume.mock.calls.length).toBeGreaterThanOrEqual(2)

    await controller.setMicrophoneMuted(true)
    expect(clearIntervalFn.mock.calls.length).toBeGreaterThan(0)
    expect(cleanup.mock.calls.length).toBe(1)
    const lastMicLevelCall = micLevelCalls.at(-1)
    expect(lastMicLevelCall?.[1]).toBe(0)
  })
})
