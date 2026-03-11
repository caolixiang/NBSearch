import { describe, expect, it } from "bun:test"
import { resolveVoiceResumeConversationId } from "./chat-shell-helpers"

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
})
