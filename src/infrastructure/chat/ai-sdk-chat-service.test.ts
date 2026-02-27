import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import { buildAnthropicMessages } from "./ai-sdk-chat-service"

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg_1",
    role: "user",
    content: "hello",
    createdAt: 1,
    status: "completed",
    ...overrides,
  }
}

describe("buildAnthropicMessages", () => {
  it("converts system/user/assistant history to model messages", () => {
    const result = buildAnthropicMessages([
      message({ id: "1", role: "system", content: "You are concise." }),
      message({ id: "2", role: "user", content: "Hi" }),
      message({ id: "3", role: "assistant", content: "Hello." }),
    ])

    expect(result).toEqual([
      { role: "system", content: "You are concise." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello." },
    ])
  })

  it("drops failed/empty/tool messages", () => {
    const result = buildAnthropicMessages([
      message({ id: "1", role: "user", content: "   " }),
      message({ id: "2", role: "assistant", content: "ok", status: "failed" }),
      message({ id: "3", role: "tool", content: "{\"x\":1}" }),
      message({ id: "4", role: "user", content: " valid " }),
    ])

    expect(result).toEqual([{ role: "user", content: "valid" }])
  })
})
