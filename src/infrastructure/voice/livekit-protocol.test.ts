import { describe, expect, it } from "bun:test"
import type { VoiceSessionSettings } from "../../domain/voice/service"
import {
  LIVEKIT_TOPIC_CHAT,
  LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS,
  buildLivekitChatPayloads,
  buildLivekitSessionUpdatePayload,
  decodeLivekitTextEnvelope,
} from "./livekit-protocol"

const decoder = new TextDecoder()

describe("livekit-protocol", () => {
  it("builds session.update payload with custom instructions", () => {
    const settings: VoiceSessionSettings = {
      voice: "ara",
      personality: null,
      instructions: "Be warm and concise.",
      isRawInstructions: true,
      speed: 1.25,
    }

    const payload = JSON.parse(decoder.decode(buildLivekitSessionUpdatePayload(settings))) as Record<string, unknown>
    const session = payload["session"] as Record<string, unknown>

    expect(payload["type"]).toBe("session.update")
    expect(session["voice"]).toBe("ara")
    expect(session["personality"]).toBeNull()
    expect(session["instructions"]).toBe("Be warm and concise.")
    expect(session["is_raw_instructions"]).toBe(true)
    expect(session["playback_speed"]).toBe(1.25)
  })

  it("builds outgoing chat payloads for both Grok and lk.chat topics", () => {
    const packets = buildLivekitChatPayloads("你好")
    expect(packets).toHaveLength(2)
    expect(packets.map((packet) => packet.topic)).toEqual(["grok.chat", LIVEKIT_TOPIC_CHAT])
    expect(packets[0]?.reliable).toBe(false)
    expect(packets[1]?.reliable).toBe(true)
  })

  it("decodes assistant transcript done from realtime server events", () => {
    const envelope = decodeLivekitTextEnvelope({
      topic: LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS,
      rawText: JSON.stringify({
        type: "response.audio_transcript.done",
        transcript: "当然可以",
        response_id: "resp_voice_1",
        conversation_id: "conv_upstream_1",
      }),
    })

    expect(envelope.conversationId).toBe("conv_upstream_1")
    expect(envelope.textEvents).toEqual([
      {
        role: "assistant",
        text: "当然可以",
        final: true,
        topic: LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS,
        responseId: "resp_voice_1",
        conversationId: "conv_upstream_1",
        source: "response.audio_transcript.done",
      },
    ])
  })

  it("decodes user audio transcription completion from realtime server events", () => {
    const envelope = decodeLivekitTextEnvelope({
      topic: LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS,
      rawText: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "帮我写个标题",
        response_id: "resp_user_voice_1",
      }),
    })

    expect(envelope.textEvents).toEqual([
      {
        role: "user",
        text: "帮我写个标题",
        final: true,
        topic: LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS,
        responseId: "resp_user_voice_1",
        source: "conversation.item.input_audio_transcription.completed",
      },
    ])
  })

  it("falls back to participant identity for plain chat payloads", () => {
    const envelope = decodeLivekitTextEnvelope({
      topic: LIVEKIT_TOPIC_CHAT,
      rawText: "你好呀",
      participantIdentity: "remote-assistant",
      localParticipantIdentity: "local-user",
    })

    expect(envelope.textEvents).toEqual([
      {
        role: "assistant",
        text: "你好呀",
        final: true,
        topic: LIVEKIT_TOPIC_CHAT,
      },
    ])
  })
})
