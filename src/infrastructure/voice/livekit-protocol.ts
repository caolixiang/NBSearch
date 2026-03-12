import type { VoiceSessionSettings, VoiceTextEvent, VoiceTextEventRole } from "../../domain/voice/service"

export const LIVEKIT_TOPIC_CHAT = "lk.chat"
export const LIVEKIT_TOPIC_TRANSCRIPTION = "lk.transcription"
export const LIVEKIT_TOPIC_GROK_CHAT = "grok.chat"
export const LIVEKIT_TOPIC_REALTIME_CLIENT_EVENT = "realtime_client_event"
export const LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS = "realtime_server_events"

const textEncoder = new TextEncoder()

export interface LivekitOutgoingTextPacket {
  topic: string
  payload: Uint8Array
  reliable: boolean
}

export interface LivekitDecodedTextEnvelope {
  textEvents: VoiceTextEvent[]
  conversationId?: string
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawText) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function resolveRole(
  participantIdentity: string,
  localParticipantIdentity: string,
  fallbackRole: VoiceTextEventRole
): VoiceTextEventRole {
  const normalizedParticipant = participantIdentity.trim()
  const normalizedLocal = localParticipantIdentity.trim()
  if (normalizedParticipant && normalizedLocal && normalizedParticipant === normalizedLocal) {
    return "user"
  }
  return fallbackRole
}

function extractConversationId(payload: Record<string, unknown>): string {
  const direct = readTrimmedString(payload["conversation_id"]) || readTrimmedString(payload["conversationId"])
  if (direct) {
    return direct
  }
  const conversation = payload["conversation"]
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    return readTrimmedString((conversation as Record<string, unknown>)["id"])
  }
  return ""
}

function extractItemId(payload: Record<string, unknown>): string {
  const direct = readTrimmedString(payload["item_id"]) || readTrimmedString(payload["itemId"])
  if (direct) {
    return direct
  }
  const item = payload["item"]
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return readTrimmedString((item as Record<string, unknown>)["id"])
  }
  return ""
}

function extractEventId(payload: Record<string, unknown>): string {
  return readTrimmedString(payload["event_id"]) || readTrimmedString(payload["eventId"])
}

function buildVoiceEventKey(role: VoiceTextEventRole, payload: Record<string, unknown>): string {
  const responseId = readTrimmedString(payload["response_id"]) || readTrimmedString(payload["responseId"])
  if (responseId) {
    return `${role}:resp:${responseId}`
  }
  const itemId = extractItemId(payload)
  if (itemId) {
    return `${role}:item:${itemId}`
  }
  const eventId = extractEventId(payload)
  if (eventId) {
    return `${role}:evt:${eventId}`
  }
  return ""
}

function buildTextEvent(
  role: VoiceTextEventRole,
  text: string,
  final: boolean,
  topic: string,
  payload: Record<string, unknown>,
  sourceType: string
): VoiceTextEvent | null {
  const normalizedText = text.trim()
  if (!normalizedText) {
    return null
  }
  const responseId = readTrimmedString(payload["response_id"]) || readTrimmedString(payload["responseId"])
  const conversationId = extractConversationId(payload)
  const itemId = extractItemId(payload)
  const eventId = extractEventId(payload)
  const voiceEventKey = buildVoiceEventKey(role, payload)
  return {
    role,
    text: normalizedText,
    final,
    topic,
    ...(responseId ? { responseId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(sourceType ? { source: sourceType } : {}),
    ...(itemId ? { itemId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(voiceEventKey ? { voiceEventKey } : {}),
  }
}

function extractAssistantCommitText(payload: Record<string, unknown>): string {
  const assistant = payload["assistant"]
  if (assistant && typeof assistant === "object" && !Array.isArray(assistant)) {
    const assistantTranscript = readTrimmedString((assistant as Record<string, unknown>)["transcript"])
    if (assistantTranscript) {
      return assistantTranscript
    }
  }
  const humanAssist = payload["humanAssist"]
  if (humanAssist && typeof humanAssist === "object" && !Array.isArray(humanAssist)) {
    const assistantValue = (humanAssist as Record<string, unknown>)["assistant"]
    if (assistantValue && typeof assistantValue === "object" && !Array.isArray(assistantValue)) {
      const transcript = readTrimmedString((assistantValue as Record<string, unknown>)["transcript"])
      if (transcript) {
        return transcript
      }
    }
  }
  return readTrimmedString(payload["text"]) || readTrimmedString(payload["transcript"])
}

export function buildLivekitSessionUpdatePayload(settings: VoiceSessionSettings): Uint8Array {
  const payload = {
    type: "session.update",
    session: {
      personality: settings.personality,
      instructions: settings.instructions.trim(),
      is_raw_instructions: settings.isRawInstructions,
      voice: settings.voice.trim(),
      playback_speed: settings.speed,
      enable_vision: false,
      turn_detection: {
        type: "server_vad",
      },
    },
  }
  return textEncoder.encode(JSON.stringify(payload))
}

export function buildLivekitChatPayloads(text: string): LivekitOutgoingTextPacket[] {
  const normalizedText = text.trim()
  if (!normalizedText) {
    return []
  }
  const encoded = textEncoder.encode(normalizedText)
  return [
    {
      topic: LIVEKIT_TOPIC_GROK_CHAT,
      payload: encoded,
      reliable: false,
    },
    {
      topic: LIVEKIT_TOPIC_CHAT,
      payload: encoded,
      reliable: true,
    },
  ]
}

export function decodeLivekitTextEnvelope(input: {
  rawText: string
  topic?: string
  participantIdentity?: string
  localParticipantIdentity?: string
}): LivekitDecodedTextEnvelope {
  const rawText = input.rawText.trim()
  const topic = (input.topic || "").trim()
  const participantIdentity = (input.participantIdentity || "").trim()
  const localParticipantIdentity = (input.localParticipantIdentity || "").trim()

  if (!rawText) {
    return { textEvents: [] }
  }

  if (topic !== LIVEKIT_TOPIC_REALTIME_SERVER_EVENTS) {
    const role = resolveRole(participantIdentity, localParticipantIdentity, "assistant")
    return {
      textEvents: [
        {
          role,
          text: rawText,
          final: true,
          topic: topic || LIVEKIT_TOPIC_CHAT,
        },
      ],
    }
  }

  const payload = parseJsonObject(rawText)
  if (!payload) {
    return {
      textEvents: [
        {
          role: resolveRole(participantIdentity, localParticipantIdentity, "assistant"),
          text: rawText,
          final: true,
          topic,
        },
      ],
    }
  }

  const sourceType = readTrimmedString(payload["type"])
  const conversationId = extractConversationId(payload)
  const textEvents: VoiceTextEvent[] = []

  if (sourceType === "response.audio_transcript.delta") {
    const event = buildTextEvent("assistant", readTrimmedString(payload["delta"]), false, topic, payload, sourceType)
    if (event) {
      textEvents.push(event)
    }
  } else if (sourceType === "response.audio_transcript.done") {
    const event = buildTextEvent("assistant", readTrimmedString(payload["transcript"]), true, topic, payload, sourceType)
    if (event) {
      textEvents.push(event)
    }
  } else if (sourceType === "conversation.item.input_audio_transcription.completed") {
    const event = buildTextEvent("user", readTrimmedString(payload["transcript"]), true, topic, payload, sourceType)
    if (event) {
      textEvents.push(event)
    }
  } else if (sourceType === "response.text.delta") {
    const deltaText =
      readTrimmedString(payload["delta"]) ||
      readTrimmedString(payload["text"])
    const event = buildTextEvent("assistant", deltaText, false, topic, payload, sourceType)
    if (event) {
      textEvents.push(event)
    }
  } else if (
    sourceType === "response.text.final" ||
    sourceType === "response.text.done" ||
    sourceType === "response.human_assist_turn.commit"
  ) {
    const finalText =
      sourceType === "response.human_assist_turn.commit"
        ? extractAssistantCommitText(payload)
        : readTrimmedString(payload["text"]) || readTrimmedString(payload["transcript"])
    const event = buildTextEvent("assistant", finalText, true, topic, payload, sourceType)
    if (event) {
      textEvents.push(event)
    }
  } else {
    const fallbackText = readTrimmedString(payload["text"]) || readTrimmedString(payload["transcript"])
    const fallbackRole = resolveRole(participantIdentity, localParticipantIdentity, "assistant")
    const event = buildTextEvent(fallbackRole, fallbackText, true, topic, payload, sourceType)
    if (event) {
      textEvents.push(event)
    }
  }

  return {
    textEvents,
    ...(conversationId ? { conversationId } : {}),
  }
}
