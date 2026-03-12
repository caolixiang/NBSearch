import { describe, expect, it } from "bun:test"
import { clearStaleSessionAnchors, getLastPendingUserMessage, resolveVoiceResumeConversationId } from "./chat-shell-helpers"

describe("chat-shell voice resume helpers", () => {
  it("skips voice resume when the conversation has no upstream session", () => {
    expect(
      resolveVoiceResumeConversationId("conv_local_1", {
        conversationId: "conv_local_1",
      })
    ).toBeUndefined()
  })

  it("skips voice resume when anchors still point at the local conversation id", () => {
    expect(
      resolveVoiceResumeConversationId("conv_local_1", {
        sessionId: "sess_existing_1",
        conversationId: "conv_local_1",
      })
    ).toBeUndefined()
  })

  it("returns the upstream conversation id for strict voice resume", () => {
    expect(
      resolveVoiceResumeConversationId("conv_local_1", {
        sessionId: "sess_existing_1",
        conversationId: "conv_upstream_1",
      })
    ).toBe("conv_upstream_1")
  })

  it("clears stale remote anchors but keeps the local conversation id", () => {
    expect(
      clearStaleSessionAnchors({
        conversationId: "conv_local_1",
        sessionId: "sess_stale_1",
        lastResponseId: "resp_stale_1",
      })
    ).toEqual({
      conversationId: "conv_local_1",
      sessionId: "",
      lastResponseId: "",
    })
  })

  it("does not treat voice user finals as pending recovery messages", () => {
    expect(
      getLastPendingUserMessage([
        {
          id: "voice_user_1",
          role: "user",
          content: "帮我看下这张图",
          voiceEventKey: "user:resp:resp_voice_1",
          createdAt: 100,
        },
      ])
    ).toBeNull()
  })
})
