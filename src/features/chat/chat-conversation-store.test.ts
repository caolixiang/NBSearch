import { afterEach, describe, expect, it } from "bun:test"
import { useChatConversationStore } from "./chat-conversation-store"

function resetStore() {
  useChatConversationStore.setState(useChatConversationStore.getInitialState(), true)
}

afterEach(() => {
  resetStore()
})

describe("chat-conversation-store", () => {
  it("updates active conversation and draft fields", () => {
    useChatConversationStore.getState().setHasDraftConversation(true)
    useChatConversationStore.getState().setDraftConversationUpdatedAt(12345)
    useChatConversationStore.getState().setActiveConversationId("conv_a")

    const state = useChatConversationStore.getState()
    expect(state.hasDraftConversation).toBe(true)
    expect(state.draftConversationUpdatedAt).toBe(12345)
    expect(state.activeConversationId).toBe("conv_a")
  })

  it("stores and appends conversation messages", () => {
    useChatConversationStore.getState().setMessagesForConversation("conv_a", [
      {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 1,
      },
    ])
    useChatConversationStore.getState().appendMessageForConversation("conv_a", {
      id: "m2",
      role: "assistant",
      content: "hi",
      createdAt: 2,
    })

    const state = useChatConversationStore.getState()
    expect(state.messagesByConversationId.conv_a?.length).toBe(2)
    expect(state.messagesByConversationId.conv_a?.[1]?.id).toBe("m2")
  })

  it("manages per-conversation streaming lifecycle", () => {
    useChatConversationStore.getState().setStreamingStateForConversation("conv_a", {
      assistantText: "",
      reasoningEvents: [],
      reasoningActive: false,
      reasoningDurationSeconds: 0,
      startedAt: 100,
      leadAnchorMessageId: "u1",
    })
    useChatConversationStore.getState().patchStreamingStateForConversation("conv_a", {
      assistantText: "partial",
      reasoningDurationSeconds: 3,
    })

    let state = useChatConversationStore.getState()
    expect(state.streamingStateByConversationId.conv_a?.assistantText).toBe("partial")
    expect(state.streamingStateByConversationId.conv_a?.reasoningDurationSeconds).toBe(3)

    useChatConversationStore.getState().removeStreamingStateForConversation("conv_a")
    state = useChatConversationStore.getState()
    expect(state.streamingStateByConversationId.conv_a).toBeUndefined()
  })

  it("clears all caches of a removed conversation", () => {
    const store = useChatConversationStore.getState()
    store.setMessagesForConversation("conv_a", [])
    store.setStreamingStateForConversation("conv_a", {
      assistantText: "x",
      reasoningEvents: [],
      reasoningActive: true,
      reasoningDurationSeconds: 1,
      startedAt: 10,
      leadAnchorMessageId: "u1",
    })
    store.setPersistedReasoningForConversation("conv_a", { resp_1: [] })
    store.setPersistedReasoningDurationForConversation("conv_a", { resp_1: 2 })
    store.setLastErrorForConversation("conv_a", "err")

    useChatConversationStore.getState().removeConversationCaches("conv_a")
    const state = useChatConversationStore.getState()
    expect(state.messagesByConversationId.conv_a).toBeUndefined()
    expect(state.streamingStateByConversationId.conv_a).toBeUndefined()
    expect(state.persistedReasoningByConversationId.conv_a).toBeUndefined()
    expect(state.persistedReasoningDurationByConversationId.conv_a).toBeUndefined()
    expect(state.lastErrorByConversationId.conv_a).toBeUndefined()
  })
})
