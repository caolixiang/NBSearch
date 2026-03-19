import { afterEach, describe, expect, it, mock } from "bun:test"
import { GatewayVoiceService } from "./gateway-voice-service"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("GatewayVoiceService", () => {
  it("sends session_id and null personality to the voice token endpoint", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      expect(body["session_id"]).toBe("sess_voice_existing_1")
      expect(body["personality"]).toBeNull()
      expect(body["stateful"]).toBe(true)
      expect(body["voice"]).toBe("ara")
      expect(body["speed"]).toBe(1)
      expect(body["voice_gateway_session_id"]).toBe("vgs_client_1")
      return new Response(
        JSON.stringify({
          token: "voice-token",
          url: "wss://livekit.example.com",
          session_id: "sess_voice_existing_1",
          request_id: "req_voice_1",
          room_name: "room_voice_1",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const service = new GatewayVoiceService({
      apiBaseUrl: "https://gateway.example.com",
      apiKey: "test-api-key",
      defaultModel: "grok-4.1",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
      voiceEnabled: true,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const result = await service.issueToken({
      sessionId: "sess_voice_existing_1",
      voice: "ara",
      personality: null,
      speed: 1,
      voiceGatewaySessionId: "vgs_client_1",
    })

    expect(result.sessionId).toBe("sess_voice_existing_1")
    expect(result.requestId).toBe("req_voice_1")
    expect(result.roomName).toBe("room_voice_1")
  })

  it("normalizes /v1/responses gateway config to the voice root endpoint", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://gateway.example.com/api/v1/voice/token")
      return new Response(
        JSON.stringify({
          token: "voice-token",
          url: "wss://livekit.example.com",
          room_name: "room_voice_1",
          participant_name: "participant_voice_1",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const service = new GatewayVoiceService({
      apiBaseUrl: "https://gateway.example.com/v1/responses",
      apiKey: "test-api-key",
      defaultModel: "grok-4.1",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
      voiceEnabled: true,
      themeMode: "light",
      fontSizeMode: "default",
    })

    await service.issueToken({
      sessionId: "sess_voice_existing_1",
      voice: "ara",
      personality: null,
      speed: 1,
      voiceGatewaySessionId: "vgs_client_1",
    })
  })

  it("retries with conversation resume when session_id is stale", async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      requestBodies.push(body)
      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify({
            status: "error",
            error: "Unknown session_id; omit session_id to create a new session",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      }
      return new Response(
        JSON.stringify({
          token: "voice-token",
          url: "wss://livekit.example.com",
          session_id: "sess_voice_rebound_1",
          conversation_id: "conv_upstream_1",
          request_id: "req_voice_2",
          room_name: "room_voice_2",
          participant_name: "participant_voice_2",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const service = new GatewayVoiceService({
      apiBaseUrl: "https://gateway.example.com/v1/responses",
      apiKey: "test-api-key",
      defaultModel: "grok-4.1",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
      voiceEnabled: true,
      themeMode: "light",
      fontSizeMode: "default",
    })

    const result = await service.issueToken({
      sessionId: "sess_voice_stale_1",
      conversationId: "conv_upstream_1",
      voice: "ara",
      personality: "assistant",
      speed: 1,
      strictResume: true,
      voiceGatewaySessionId: "vgs_client_2",
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBodies[0]?.["session_id"]).toBe("sess_voice_stale_1")
    expect(requestBodies[0]?.["conversation_id"]).toBe("conv_upstream_1")
    expect(requestBodies[0]?.["strict_resume"]).toBe(true)
    expect(requestBodies[1]?.["session_id"]).toBeUndefined()
    expect(requestBodies[1]?.["conversation_id"]).toBe("conv_upstream_1")
    expect(requestBodies[1]?.["strict_resume"]).toBe(true)
    expect(result.sessionId).toBe("sess_voice_rebound_1")
    expect(result.conversationId).toBe("conv_upstream_1")
    expect(result.requestId).toBe("req_voice_2")
  })

  it("surfaces plain-text gateway errors instead of a generic fallback", async () => {
    const fetchMock = mock(async () => new Response("gateway overloaded", { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const service = new GatewayVoiceService({
      apiBaseUrl: "https://gateway.example.com",
      apiKey: "test-api-key",
      defaultModel: "grok-4.1",
      llmApiBaseUrl: "https://cpabak.zeabur.app/v1",
      llmApiKey: "",
      llmTranslationModel: "gpt-5.4",
      voiceEnabled: true,
      themeMode: "light",
      fontSizeMode: "default",
    })

    await expect(
      service.issueToken({
        voice: "ara",
        personality: null,
        speed: 1,
        voiceGatewaySessionId: "vgs_client_3",
      })
    ).rejects.toThrow("gateway overloaded")
  })
})
