import { describe, expect, it } from "bun:test"
import {
  coerceGatewaySessionMessages,
  coerceGatewaySessionState,
  coerceGatewayTurnState,
  createGatewaySessionRecoveryClient,
  normalizeTurnRecoverySetting,
} from "./gateway-session-recovery"

describe("normalizeTurnRecoverySetting", () => {
  it("clamps numeric values to the configured max", () => {
    expect(normalizeTurnRecoverySetting(42, 3, 10)).toBe(10)
  })

  it("falls back when the input is invalid", () => {
    expect(normalizeTurnRecoverySetting("oops", 3, 10)).toBe(3)
  })
})

describe("coerceGatewayTurnState", () => {
  it("reads nested turn payloads and normalizes snake/camel fields", () => {
    expect(
      coerceGatewayTurnState({
        status: "completed",
        response_id: "resp_turn_1",
        updatedAt: "123",
        error: {
          code: "",
          message: "",
        },
      })
    ).toEqual({
      status: "completed",
      responseId: "resp_turn_1",
      errorCode: "",
      errorMessage: "",
      updatedAt: 123,
    })
  })
})

describe("coerceGatewaySessionState", () => {
  it("reads in-progress session state from nested payload", () => {
    expect(
      coerceGatewaySessionState({
        session: {
          sessionId: "sess_1",
          last_response_id: "resp_last_1",
          in_progress: true,
          activeClientTurnId: "turn_1",
          updated_at: 456,
        },
      })
    ).toEqual({
      sessionId: "sess_1",
      lastResponseId: "resp_last_1",
      inProgress: true,
      activeClientTurnId: "turn_1",
      updatedAt: 456,
    })
  })
})

describe("coerceGatewaySessionMessages", () => {
  it("flattens structured content blocks and maps streaming status", () => {
    expect(
      coerceGatewaySessionMessages({
        data: {
          messages: [
            {
              id: "msg_1",
              responseId: "resp_1",
              previousResponseId: "resp_prev_1",
              role: "assistant",
              status: "in_progress",
              created_at: 789,
              client_turn_id: "turn_1",
              content: [
                { text: "line 1" },
                { content: [{ text: "line 2" }] },
              ],
            },
          ],
        },
      })
    ).toEqual([
      {
        id: "msg_1",
        responseId: "resp_1",
        previousResponseId: "resp_prev_1",
        role: "assistant",
        content: "line 1\nline 2",
        status: "streaming",
        createdAt: 789,
        clientTurnId: "turn_1",
      },
    ])
  })
})

describe("createGatewaySessionRecoveryClient", () => {
  it("falls back to the full message list when after_response_id is invalid", async () => {
    const calls: string[] = []
    const runtimeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("after_response_id=resp_prev_1")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_after_response_id",
            },
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
          messages: [
            {
              id: "msg_1",
              response_id: "resp_1",
              role: "assistant",
              status: "completed",
              content: "Recovered",
              created_at: 1000,
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    }) as unknown as typeof fetch
    ;(runtimeFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}

    const client = createGatewaySessionRecoveryClient({
      gatewayBaseUrl: "http://127.0.0.1:8787/v1",
      runtimeFetch,
      createAuthHeaders: () => ({ Authorization: "Bearer test" }),
      turnRecoveryMessagesLimit: 50,
    })

    const rows = await client.querySessionMessages("sess_1", "resp_prev_1")

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("after_response_id=resp_prev_1")
    expect(calls[1]).not.toContain("after_response_id=")
    expect(rows).toEqual([
      {
        id: "msg_1",
        responseId: "resp_1",
        previousResponseId: "",
        role: "assistant",
        content: "Recovered",
        status: "completed",
        createdAt: 1000,
        clientTurnId: "",
      },
    ])
  })
})
