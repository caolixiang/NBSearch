import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import type { GatewaySessionMessage } from "./gateway-session-recovery"
import { resolveGatewayRegenerateTarget } from "./gateway-regenerate-target-resolver"

function userMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: 1,
  }
}

function assistantMessage(
  id: string,
  content: string,
  responseId?: string,
  previousResponseId?: string
): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: 2,
    responseId,
    previousResponseId,
    status: "completed",
  }
}

function sessionUser(content: string): GatewaySessionMessage {
  return {
    id: `usr_${content}`,
    responseId: "",
    previousResponseId: "",
    role: "user",
    content,
    status: "completed",
    createdAt: 1,
    clientTurnId: "turn_1",
  }
}

function sessionAssistant(
  content: string,
  responseId: string,
  previousResponseId = ""
): GatewaySessionMessage {
  return {
    id: responseId,
    responseId,
    previousResponseId,
    role: "assistant",
    content,
    status: "completed",
    createdAt: 2,
    clientTurnId: "turn_1",
  }
}

describe("resolveGatewayRegenerateTarget", () => {
  it("returns empty ids when target assistant is missing", () => {
    const resolved = resolveGatewayRegenerateTarget({
      localMessages: [userMessage("usr_1", "hi")],
      sessionMessages: [sessionAssistant("hello", "resp_remote_1")],
      messageId: "missing",
    })

    expect(resolved).toEqual({
      targetMessage: null,
      matchedAssistant: null,
      resolvedResponseId: "",
      resolvedPreviousResponseId: "",
    })
  })

  it("falls back to local ids when session messages are empty", () => {
    const resolved = resolveGatewayRegenerateTarget({
      localMessages: [assistantMessage("asst_1", "hello", "resp_local_1", "resp_prev_local_1")],
      sessionMessages: [],
      messageId: "asst_1",
    })

    expect(resolved.resolvedResponseId).toBe("resp_local_1")
    expect(resolved.resolvedPreviousResponseId).toBe("resp_prev_local_1")
    expect(resolved.matchedAssistant).toBeNull()
  })

  it("matches by renderable role shape first", () => {
    const resolved = resolveGatewayRegenerateTarget({
      localMessages: [userMessage("usr_1", "hi"), assistantMessage("asst_1", "hello")],
      sessionMessages: [sessionUser("hi"), sessionAssistant("hello", "resp_remote_1", "resp_prev_1")],
      messageId: "asst_1",
    })

    expect(resolved.resolvedResponseId).toBe("resp_remote_1")
    expect(resolved.resolvedPreviousResponseId).toBe("resp_prev_1")
  })

  it("falls back to assistant ordinal when session order drifts", () => {
    const resolved = resolveGatewayRegenerateTarget({
      localMessages: [
        userMessage("usr_1", "q1"),
        assistantMessage("asst_1", "a1"),
        userMessage("usr_2", "q2"),
        assistantMessage("asst_2", "a2"),
      ],
      sessionMessages: [
        sessionAssistant("a1", "resp_remote_1"),
        sessionUser("q1"),
        sessionAssistant("a2", "resp_remote_2", "resp_prev_2"),
      ],
      messageId: "asst_2",
    })

    expect(resolved.resolvedResponseId).toBe("resp_remote_2")
    expect(resolved.resolvedPreviousResponseId).toBe("resp_prev_2")
  })

  it("falls back to unique exact content match", () => {
    const resolved = resolveGatewayRegenerateTarget({
      localMessages: [
        userMessage("usr_1", "q1"),
        assistantMessage("asst_1", "shared answer", "resp_local_1"),
      ],
      sessionMessages: [
        sessionUser("different"),
        sessionAssistant("shared answer", "resp_remote_1", "resp_prev_1"),
        sessionAssistant("other", "resp_remote_2"),
      ],
      messageId: "asst_1",
    })

    expect(resolved.resolvedResponseId).toBe("resp_remote_1")
    expect(resolved.resolvedPreviousResponseId).toBe("resp_prev_1")
  })

  it("keeps local ids when assistant ordinal misses and exact content is ambiguous", () => {
    const resolved = resolveGatewayRegenerateTarget({
      localMessages: [
        assistantMessage("asst_1", "first", "resp_local_1"),
        assistantMessage("asst_2", "second", "resp_local_2"),
        assistantMessage("asst_3", "same", "resp_local_3", "resp_prev_local_3"),
      ],
      sessionMessages: [
        sessionAssistant("same", "resp_remote_1"),
        sessionAssistant("same", "resp_remote_2"),
      ],
      messageId: "asst_3",
    })

    expect(resolved.resolvedResponseId).toBe("resp_local_3")
    expect(resolved.resolvedPreviousResponseId).toBe("resp_prev_local_3")
  })
})
