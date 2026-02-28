import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import {
  buildAnthropicMessages,
  extractCardAttachmentsFromRawChunk,
  extractReasoningEventsFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
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

describe("extractWebSearchToolMetaFromRawChunk", () => {
  it("extracts web_search num_results from output item events", () => {
    const rows = extractWebSearchToolMetaFromRawChunk({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "web_search",
        arguments: "{\"query\":\"foo\",\"num_results\":\"10\"}",
      },
    })
    expect(rows).toEqual([{ query: "foo", numResults: 10 }])
  })

  it("extracts web_search rows from response.completed payload", () => {
    const rows = extractWebSearchToolMetaFromRawChunk({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            name: "web_search",
            arguments: { query: "bar", num_results: 5 },
          },
        ],
      },
    })
    expect(rows).toEqual([{ query: "bar", numResults: 5 }])
  })
})

describe("extractCardAttachmentsFromRawChunk", () => {
  it("extracts image cards from cardAttachment jsonData", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          cardAttachment: {
            jsonData:
              "{\"id\":\"card_1\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/a.jpg\",\"thumbnail\":\"https://img.test/t.jpg\",\"title\":\"A\"}}",
          },
        },
      },
    })

    expect(cards).toEqual([
      {
        id: "card_1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/a.jpg",
          thumbnail: "https://img.test/t.jpg",
          title: "A",
          link: undefined,
          source: undefined,
        },
        url: undefined,
      },
    ])
  })
})

describe("extractReasoningEventsFromRawChunk", () => {
  it("extracts ui layout + tool usage + tool result events", () => {
    const events = extractReasoningEventsFromRawChunk({
      result: {
        response: {
          isThinking: true,
          responseId: "resp_1",
          rolloutId: "Agent 1",
          uiLayout: {
            reasoningUiLayout: "UNIFIED",
            willThinkLong: true,
            effort: "HIGH",
            rolloutIds: ["Grok", "Agent 1"],
          },
          toolUsageCard: {
            toolUsageCardId: "tool_1",
            webSearch: {
              args: {
                query: "hello",
              },
            },
          },
          toolUsageCardId: "tool_1",
          webSearchResults: {
            results: [{ url: "https://a.test" }, { url: "https://b.test" }],
          },
        },
      },
    })

    expect(events).toEqual([
      {
        kind: "ui_layout",
        layout: {
          reasoningUiLayout: "UNIFIED",
          willThinkLong: true,
          effort: "HIGH",
          rolloutIds: ["Grok", "Agent 1"],
        },
        isThinking: true,
        responseId: "resp_1",
      },
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "tool_1",
          toolName: "webSearch",
          args: {
            query: "hello",
          },
          rolloutId: "Agent 1",
          messageTag: undefined,
          isThinking: true,
          responseId: "resp_1",
        },
      },
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "tool_1",
          rolloutId: "Agent 1",
          messageTag: undefined,
          webSearchResultsCount: 2,
          isThinking: true,
          responseId: "resp_1",
        },
      },
    ])
  })
})

describe("resolveConversationTitle", () => {
  it("prefers upstream newTitle", () => {
    const title = resolveConversationTitle("Friendly greeting", "")
    expect(title).toBe("Friendly greeting")
  })

  it("keeps existing title when upstream title is missing", () => {
    const title = resolveConversationTitle("", "已存在标题")
    expect(title).toBe("已存在标题")
  })

  it("keeps empty title when both upstream and existing titles are missing", () => {
    const title = resolveConversationTitle("", "")
    expect(title).toBe("")
  })
})
