import { describe, expect, it } from "bun:test"
import type { ChatStreamEvent, ChatTurnResult } from "../../domain/chat/types"
import { createGatewayStreamEventEmitter } from "./gateway-stream-event-emitter"

const completedTurnResult: ChatTurnResult = {
  assistantMessage: {
    id: "asst_1",
    role: "assistant",
    content: "done",
    createdAt: 3,
    responseId: "resp_1",
    status: "completed",
  },
  anchors: {
    conversationId: "conv_1",
    sessionId: "sess_1",
    lastResponseId: "resp_1",
  },
}

describe("createGatewayStreamEventEmitter", () => {
  it("emits monotonic meta sequence and falls back to stored response id", () => {
    const events: ChatStreamEvent[] = []
    let tick = 100
    const emitter = createGatewayStreamEventEmitter({
      conversationId: "conv_1",
      onEvent: (event) => events.push(event),
      now: () => {
        tick += 1
        return tick
      },
    })

    emitter.emitStarted("req_1")
    emitter.setGatewayResponseId("resp_1")
    emitter.emitHeartbeat(10)
    emitter.emitDelta("Hello")
    emitter.emitCompleted(completedTurnResult)

    expect(events.map((event) => event.type)).toEqual(["started", "heartbeat", "delta", "completed"])
    for (let index = 0; index < events.length; index += 1) {
      expect(events[index]?.meta.seq).toBe(index + 1)
      expect(events[index]?.meta.ts).toBe(101 + index)
      expect(events[index]?.meta.conversationId).toBe("conv_1")
    }
    expect(events[0]?.meta.responseId).toBeUndefined()
    expect(events[1]?.meta.responseId).toBe("resp_1")
    expect(events[2]?.meta.responseId).toBe("resp_1")
    expect(events[3]?.meta.responseId).toBe("resp_1")
    expect(emitter.state.gatewayResponseId).toBe("resp_1")
    expect(emitter.state.streamEventSeq).toBe(4)
  })

  it("prefers explicit response id over stored state for reasoning and failures", () => {
    const events: ChatStreamEvent[] = []
    const emitter = createGatewayStreamEventEmitter({
      conversationId: "conv_2",
      onEvent: (event) => events.push(event),
      initialState: {
        gatewayResponseId: "resp_default",
        streamEventSeq: 10,
      },
    })

    emitter.emitReasoning(
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "tool_1",
        },
      },
      "resp_reasoning"
    )
    emitter.emitFailed("chat_stream_error", "boom")

    expect(events).toHaveLength(2)
    expect(events[0]?.meta.seq).toBe(11)
    expect(events[0]?.meta.responseId).toBe("resp_reasoning")
    expect(events[1]?.meta.seq).toBe(12)
    expect(events[1]?.meta.responseId).toBe("resp_reasoning")
  })
})
