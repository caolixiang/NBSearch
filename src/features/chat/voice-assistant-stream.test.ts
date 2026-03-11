import { describe, expect, it } from "bun:test"
import {
  classifyVoiceAssistantDeltaSource,
  resolveVoiceAssistantDeltaTracker,
  type VoiceAssistantDeltaTracker,
} from "./voice-assistant-stream"

describe("voice-assistant-stream", () => {
  it("classifies assistant delta sources", () => {
    expect(classifyVoiceAssistantDeltaSource("response.audio_transcript.delta")).toBe("audio")
    expect(classifyVoiceAssistantDeltaSource("response.text.delta")).toBe("text")
    expect(classifyVoiceAssistantDeltaSource("livekit.chatMessage")).toBe("other")
  })

  it("accepts the first delta source for a response and keeps it stable", () => {
    const first = resolveVoiceAssistantDeltaTracker(null, {
      responseId: "resp_voice_1",
      source: "response.audio_transcript.delta",
    })
    expect(first.accept).toBe(true)
    expect(first.next).toEqual({
      responseId: "resp_voice_1",
      source: "audio",
    })

    const second = resolveVoiceAssistantDeltaTracker(first.next, {
      responseId: "resp_voice_1",
      source: "response.text.delta",
    })
    expect(second.accept).toBe(false)
    expect(second.next).toEqual(first.next)
  })

  it("allows a new delta source when response id changes", () => {
    const current: VoiceAssistantDeltaTracker = {
      responseId: "resp_voice_1",
      source: "audio",
    }

    const next = resolveVoiceAssistantDeltaTracker(current, {
      responseId: "resp_voice_2",
      source: "response.text.delta",
    })

    expect(next.accept).toBe(true)
    expect(next.next).toEqual({
      responseId: "resp_voice_2",
      source: "text",
    })
  })
})
