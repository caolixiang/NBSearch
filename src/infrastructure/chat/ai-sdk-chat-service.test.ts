import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import {
  buildAnthropicMessages,
  extractResponseNewTitleFromRawChunk,
  resolveConversationTitle,
} from "./ai-sdk-chat-service"

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

describe("extractResponseNewTitleFromRawChunk", () => {
  it("extracts newTitle from responses completed chunk", () => {
    const title = extractResponseNewTitleFromRawChunk({
      type: "response.completed",
      response: {
        title: {
          newTitle: "Friendly greeting",
        },
      },
    })

    expect(title).toBe("Friendly greeting")
  })

  it("returns empty string when chunk has no newTitle", () => {
    const title = extractResponseNewTitleFromRawChunk({
      type: "response.output_text.delta",
      delta: "hello",
    })

    expect(title).toBe("")
  })
})

describe("resolveConversationTitle", () => {
  it("prefers upstream newTitle", () => {
    const title = resolveConversationTitle("用户第一句", "Friendly greeting")
    expect(title).toBe("Friendly greeting")
  })

  it("falls back to local title derivation", () => {
    const title = resolveConversationTitle("   戴佩妮是谁？   ", "")
    expect(title).toBe("戴佩妮是谁？")
  })
})
