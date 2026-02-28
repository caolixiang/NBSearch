import { describe, expect, it } from "bun:test"
import type { ChatMessage } from "../../domain/chat/types"
import {
  buildAnthropicMessages,
  extractCardAttachmentsFromRawChunk,
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
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

describe("gateway raw chunk extractors", () => {
  it("extracts token/message/responseId from responses stream events", () => {
    const rawChunk = {
      type: "response.output_text.delta",
      delta: "你",
      response_id: "resp_stream_1",
    }

    expect(extractGatewayTextDeltaFromRawChunk(rawChunk)).toBe("你")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_stream_1")
  })

  it("extracts final message and response id from response.completed event", () => {
    const rawChunk = {
      type: "response.completed",
      response: {
        id: "resp_completed_1",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "你好！",
              },
            ],
          },
        ],
      },
    }

    expect(extractGatewayFinalMessageFromRawChunk(rawChunk)).toBe("你好！")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_completed_1")
  })

  it("extracts final message from response.output_text.done event", () => {
    const rawChunk = {
      type: "response.output_text.done",
      text: "最终答案",
      response_id: "resp_done_1",
    }

    expect(extractGatewayFinalMessageFromRawChunk(rawChunk)).toBe("最终答案")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_done_1")
  })

  it("extracts response id from response.created payload", () => {
    const rawChunk = {
      type: "response.created",
      response: {
        id: "resp_created_1",
      },
    }

    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_created_1")
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
  it("extracts generated images from response.completed image_generation", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.completed",
      response: {
        id: "resp_1",
        image_generation: {
          data: [{ url: "https://img.test/a.jpg" }, { url: "https://img.test/b.jpg" }],
        },
      },
    })

    expect(cards).toHaveLength(2)
    expect(cards[0]?.type).toBe("generated_image")
    expect(cards[0]?.image?.original).toBe("https://img.test/a.jpg")
    expect(cards[1]?.image?.original).toBe("https://img.test/b.jpg")
  })

  it("extracts generated images from current top-level data payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.completed",
      data: [{ url: "https://img.test/a.jpg" }, { url: "https://img.test/b.jpg" }],
    })

    expect(cards).toHaveLength(2)
    expect(cards[0]?.type).toBe("generated_image")
    expect(cards[0]?.image?.original).toBe("https://img.test/a.jpg")
    expect(cards[1]?.image?.original).toBe("https://img.test/b.jpg")
  })
})

describe("extractReasoningEventsFromRawChunk", () => {
  it("extracts ui layout from response.created", () => {
    const events = extractReasoningEventsFromRawChunk({
      type: "response.created",
      response: {
        id: "resp_1",
        uiLayout: {
          reasoningUiLayout: "UNIFIED",
          willThinkLong: true,
          effort: "HIGH",
          rolloutIds: ["Grok", "Agent 1"],
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
        isThinking: undefined,
        responseId: "resp_1",
      },
    ])
  })

  it("extracts tool usage from response.output_item.added", () => {
    const events = extractReasoningEventsFromRawChunk({
      type: "response.output_item.added",
      response_id: "resp_1",
      item: {
        type: "function_call",
        id: "fc_1",
        name: "web_search",
        arguments: "{\"query\":\"hello\"}",
        rollout_id: "Agent 1",
      },
    })

    expect(events).toEqual([
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "fc_1",
          toolName: "web_search",
          args: {
            query: "hello",
          },
          rolloutId: "Agent 1",
          messageTag: undefined,
          isThinking: undefined,
          responseId: "resp_1",
        },
      },
    ])
  })

  it("extracts tool usage from response.tool_usage_card", () => {
    const events = extractReasoningEventsFromRawChunk({
      type: "response.tool_usage_card",
      response_id: "resp_1",
      isThinking: true,
      messageTag: "tool_usage_card",
      rolloutId: "Agent 1",
      toolUsageCard: {
        toolUsageCardId: "tool_1",
        webSearch: {
          args: {
            query: "hello",
          },
        },
      },
    })

    expect(events).toEqual([
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "tool_1",
          toolName: "webSearch",
          args: {
            query: "hello",
          },
          rolloutId: "Agent 1",
          messageTag: "tool_usage_card",
          isThinking: true,
          responseId: "resp_1",
        },
      },
    ])
  })

  it("extracts tool result count from raw_function_result payload", () => {
    const events = extractReasoningEventsFromRawChunk({
      type: "response.tool_usage_card",
      response_id: "resp_1",
      isThinking: false,
      messageTag: "raw_function_result",
      rolloutId: "Agent 1",
      toolUsageCardId: "tool_1",
      webSearchResults: [{ url: "https://a.test" }, { url: "https://b.test" }],
    })

    expect(events).toEqual([
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "tool_1",
          rolloutId: "Agent 1",
          messageTag: "raw_function_result",
          webSearchResultsCount: 2,
          isThinking: false,
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
