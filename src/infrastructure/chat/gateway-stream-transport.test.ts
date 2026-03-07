import { describe, expect, it } from "bun:test"
import type { ChatTurnResult } from "../../domain/chat/types"
import { GatewayStreamAccumulator } from "./gateway-stream-accumulator"
import { executeGatewayStreamTransport } from "./gateway-stream-transport"
import type { GatewayTurnRecoveryOutcome } from "./gateway-turn-recovery"

function createStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
      },
    }
  )
}

function createPendingStreamingResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // keep open to trigger idle timeout
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
      },
    }
  )
}

const completedTurnResult: ChatTurnResult = {
  assistantMessage: {
    id: "asst_1",
    role: "assistant",
    content: "Recovered from recovery",
    createdAt: 3,
    responseId: "resp_recovered_1",
    status: "completed",
  },
  anchors: {
    conversationId: "conv_1",
    sessionId: "sess_1",
    lastResponseId: "resp_recovered_1",
  },
}

function createAttemptRecoveryStub(rows: GatewayTurnRecoveryOutcome[]) {
  let index = 0
  return async () => {
    const next = rows[Math.min(index, rows.length - 1)] || { kind: "none" }
    index += 1
    return next
  }
}

describe("executeGatewayStreamTransport", () => {
  it("retries once without previous_response_id on session anchor conflict", async () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")
    const requestBodies: string[] = []
    let fetchCallCount = 0
    const mockedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCallCount += 1
      requestBodies.push(typeof init?.body === "string" ? init.body : "")
      if (fetchCallCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: "session_anchor_conflict",
              message: "previous_response_id does not match session anchor",
              type: "invalid_request_error",
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
      return createStreamingResponse([
        JSON.stringify({ type: "response.output_text.delta", delta: "Recovered" }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_anchor_retry_1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Recovered" }],
              },
            ],
          },
        }),
      ])
    }) as unknown as typeof fetch

    const deltas: string[] = []
    const outcome = await executeGatewayStreamTransport({
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      runtimeFetch: mockedFetch,
      createAuthHeaders: (extra) => extra || {},
      clientTurnId: "turn_1",
      requestBodyPayload: {
        model: "grok-4.1-fast",
        stream: true,
        previous_response_id: "resp_prev_1",
      },
      accumulator,
      isRegenerate: false,
      streamIdleTimeoutMs: 10,
      streamIdleRetryMaxAttempts: 0,
      streamIdleRetryDelayMs: 0,
      turnRecoveryNotFoundRetryMaxAttempts: 1,
      turnInProgressRetryMaxAttempts: 0,
      turnInProgressRetryDelayMs: 0,
      emitDelta: (delta) => deltas.push(delta),
      emitReasoning: () => undefined,
      emitHeartbeat: () => undefined,
      attemptTurnRecovery: createAttemptRecoveryStub([{ kind: "none" }]),
    })

    expect(fetchCallCount).toBe(2)
    expect(requestBodies).toHaveLength(2)
    expect((JSON.parse(requestBodies[0] || "{}") as Record<string, unknown>)["previous_response_id"]).toBe(
      "resp_prev_1"
    )
    expect((JSON.parse(requestBodies[1] || "{}") as Record<string, unknown>)["previous_response_id"]).toBeUndefined()
    expect(deltas.join("")).toBe("Recovered")
    expect(outcome).toEqual({
      kind: "stream_finished",
      gatewayResponseId: "resp_anchor_retry_1",
    })
  })

  it("returns completed when transport failure recovers from turn state", async () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")
    const mockedFetch = (async () => {
      throw new Error("network_failed")
    }) as unknown as typeof fetch

    const outcome = await executeGatewayStreamTransport({
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      runtimeFetch: mockedFetch,
      createAuthHeaders: (extra) => extra || {},
      clientTurnId: "turn_1",
      requestBodyPayload: {
        model: "grok-4.1-fast",
        stream: true,
      },
      accumulator,
      isRegenerate: false,
      streamIdleTimeoutMs: 10,
      streamIdleRetryMaxAttempts: 0,
      streamIdleRetryDelayMs: 0,
      turnRecoveryNotFoundRetryMaxAttempts: 1,
      turnInProgressRetryMaxAttempts: 0,
      turnInProgressRetryDelayMs: 0,
      emitDelta: () => undefined,
      emitReasoning: () => undefined,
      emitHeartbeat: () => undefined,
      attemptTurnRecovery: createAttemptRecoveryStub([
        {
          kind: "completed",
          result: completedTurnResult,
        },
      ]),
    })

    expect(outcome).toEqual({
      kind: "completed",
      gatewayResponseId: "",
      result: completedTurnResult,
    })
  })

  it("retries one idle-timeout attempt and then finishes stream", async () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")
    let fetchCallCount = 0
    const mockedFetch = (async () => {
      fetchCallCount += 1
      if (fetchCallCount === 1) {
        return createPendingStreamingResponse()
      }
      return createStreamingResponse([
        JSON.stringify({ type: "response.output_text.delta", delta: "After retry" }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_retry_1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "After retry" }],
              },
            ],
          },
        }),
      ])
    }) as unknown as typeof fetch

    let waits = 0
    const outcome = await executeGatewayStreamTransport({
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      runtimeFetch: mockedFetch,
      createAuthHeaders: (extra) => extra || {},
      clientTurnId: "turn_1",
      requestBodyPayload: {
        model: "grok-4.1-fast",
        stream: true,
      },
      accumulator,
      isRegenerate: false,
      streamIdleTimeoutMs: 1,
      streamIdleRetryMaxAttempts: 1,
      streamIdleRetryDelayMs: 5,
      turnRecoveryNotFoundRetryMaxAttempts: 1,
      turnInProgressRetryMaxAttempts: 0,
      turnInProgressRetryDelayMs: 0,
      emitDelta: () => undefined,
      emitReasoning: () => undefined,
      emitHeartbeat: () => undefined,
      attemptTurnRecovery: createAttemptRecoveryStub([{ kind: "none" }]),
      wait: async () => {
        waits += 1
      },
    })

    expect(fetchCallCount).toBe(2)
    expect(waits).toBe(1)
    expect(outcome).toEqual({
      kind: "stream_finished",
      gatewayResponseId: "resp_retry_1",
    })
  })

  it("returns turn_in_progress failure when recovery budget is exhausted", async () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")
    const mockedFetch = (async () => {
      throw new Error("network_failed")
    }) as unknown as typeof fetch

    const outcome = await executeGatewayStreamTransport({
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      runtimeFetch: mockedFetch,
      createAuthHeaders: (extra) => extra || {},
      clientTurnId: "turn_1",
      requestBodyPayload: {
        model: "grok-4.1-fast",
        stream: true,
      },
      accumulator,
      isRegenerate: false,
      streamIdleTimeoutMs: 10,
      streamIdleRetryMaxAttempts: 0,
      streamIdleRetryDelayMs: 0,
      turnRecoveryNotFoundRetryMaxAttempts: 1,
      turnInProgressRetryMaxAttempts: 0,
      turnInProgressRetryDelayMs: 0,
      emitDelta: () => undefined,
      emitReasoning: () => undefined,
      emitHeartbeat: () => undefined,
      attemptTurnRecovery: createAttemptRecoveryStub([{ kind: "in_progress" }]),
    })

    expect(outcome).toEqual({
      kind: "failed",
      gatewayResponseId: "",
      code: "turn_in_progress",
      message: "turn_is_still_in_progress",
    })
  })
})
