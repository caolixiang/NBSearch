import { describe, expect, it } from "bun:test"
import {
  getConversationStreamingState,
  isConversationStreaming,
  patchConversationStreamingState,
  removeConversationStreamingState,
  upsertConversationStreamingState,
  type ConversationStreamingStateMap,
} from "./conversation-streaming-state"

describe("conversation-streaming-state", () => {
  it("returns undefined for missing active conversation state", () => {
    const map: ConversationStreamingStateMap = {}
    expect(getConversationStreamingState(map, null)).toBeUndefined()
    expect(getConversationStreamingState(map, "conv_a")).toBeUndefined()
  })

  it("detects whether a conversation is currently streaming", () => {
    const map = upsertConversationStreamingState({}, "conv_a", {
      assistantText: "hello",
      reasoningEvents: [],
      reasoningActive: true,
      reasoningDurationSeconds: 3,
      startedAt: 1000,
      leadAnchorMessageId: "msg_1",
    })
    expect(isConversationStreaming(map, "conv_a")).toBe(true)
    expect(isConversationStreaming(map, "conv_b")).toBe(false)
  })

  it("patches an existing streaming state without touching other conversations", () => {
    const map = upsertConversationStreamingState({}, "conv_a", {
      assistantText: "a",
      reasoningEvents: [],
      reasoningActive: true,
      reasoningDurationSeconds: 1,
      startedAt: 1000,
      leadAnchorMessageId: "msg_a",
    })
    const withSecond = upsertConversationStreamingState(map, "conv_b", {
      assistantText: "b",
      reasoningEvents: [],
      reasoningActive: false,
      reasoningDurationSeconds: 2,
      startedAt: 2000,
      leadAnchorMessageId: "msg_b",
    })

    const next = patchConversationStreamingState(withSecond, "conv_a", {
      assistantText: "a2",
      reasoningDurationSeconds: 5,
    })

    expect(next.conv_a?.assistantText).toBe("a2")
    expect(next.conv_a?.reasoningDurationSeconds).toBe(5)
    expect(next.conv_b?.assistantText).toBe("b")
    expect(next.conv_b?.reasoningDurationSeconds).toBe(2)
  })

  it("returns original map when patch target does not exist", () => {
    const map: ConversationStreamingStateMap = {}
    const next = patchConversationStreamingState(map, "conv_missing", { assistantText: "x" })
    expect(next).toBe(map)
  })

  it("removes only the requested conversation state", () => {
    const map = upsertConversationStreamingState({}, "conv_a", {
      assistantText: "a",
      reasoningEvents: [],
      reasoningActive: true,
      reasoningDurationSeconds: 1,
      startedAt: 1000,
      leadAnchorMessageId: "msg_a",
    })
    const withSecond = upsertConversationStreamingState(map, "conv_b", {
      assistantText: "b",
      reasoningEvents: [],
      reasoningActive: false,
      reasoningDurationSeconds: 2,
      startedAt: 2000,
      leadAnchorMessageId: "msg_b",
    })

    const next = removeConversationStreamingState(withSecond, "conv_a")
    expect(next.conv_a).toBeUndefined()
    expect(next.conv_b?.assistantText).toBe("b")
  })
})
