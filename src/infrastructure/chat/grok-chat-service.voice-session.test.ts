import { afterEach, describe, expect, it, mock } from "bun:test"
import { attachRuntimeFetch, createTestGrokChatService } from "./grok-chat-service-test-helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("GrokChatService inspectSessionAvailability", () => {
  it("returns available when session state responds 200", async () => {
    const { service } = createTestGrokChatService({
      apiBaseUrl: "http://localhost:8787/v1/responses",
    })
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_alive_1",
          last_response_id: "resp_1",
          in_progress: false,
          updated_at: Date.now(),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    attachRuntimeFetch(service, fetchMock as unknown as typeof fetch)

    await expect(service.inspectSessionAvailability("sess_alive_1")).resolves.toBe("available")
  })

  it("returns missing when session state responds 404", async () => {
    const { service } = createTestGrokChatService({
      apiBaseUrl: "http://localhost:8787/v1/responses",
    })
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "session_not_found",
          },
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    attachRuntimeFetch(service, fetchMock as unknown as typeof fetch)

    await expect(service.inspectSessionAvailability("sess_missing_1")).resolves.toBe("missing")
  })

  it("returns unknown when the state check fails", async () => {
    const { service } = createTestGrokChatService({
      apiBaseUrl: "http://localhost:8787/v1/responses",
    })
    const fetchMock = mock(async () => {
      throw new Error("network down")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    attachRuntimeFetch(service, fetchMock as unknown as typeof fetch)

    await expect(service.inspectSessionAvailability("sess_unknown_1")).resolves.toBe("unknown")
  })
})
