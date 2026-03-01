import { describe, expect, it } from "bun:test"
import {
  extractCardAttachmentsFromRawChunk,
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractReasoningEventsFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
  extractResponseNewTitleFromRawChunk,
  resolveConversationTitle,
} from "./chunk-parsers"

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

  it("extracts newTitle from wrapped gateway payload", () => {
    const title = extractResponseNewTitleFromRawChunk({
      result: {
        title: {
          newTitle: "刘美贤冬奥金牌照片",
        },
      },
    })

    expect(title).toBe("刘美贤冬奥金牌照片")
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

  it("extracts token and responseId from wrapped gateway token payload", () => {
    const rawChunk = {
      result: {
        response: {
          token: "你好",
          messageTag: "final",
          isThinking: false,
          responseId: "resp_wrapped_1",
        },
      },
    }

    expect(extractGatewayTextDeltaFromRawChunk(rawChunk)).toBe("你好")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_wrapped_1")
  })

  it("ignores wrapped non-final token payload", () => {
    const rawChunk = {
      result: {
        response: {
          token: "Thinking about your request",
          messageTag: "header",
          isThinking: true,
          responseId: "resp_wrapped_2",
        },
      },
    }

    expect(extractGatewayTextDeltaFromRawChunk(rawChunk)).toBe("")
  })

  it("ignores wrapped internal relay json token payload", () => {
    const rawChunk = {
      result: {
        response: {
          token: '{"message":"用户要张国荣生平附带图片","to":"Grok"}',
          messageTag: "final",
          isThinking: false,
          responseId: "resp_wrapped_internal_1",
        },
      },
    }

    expect(extractGatewayTextDeltaFromRawChunk(rawChunk)).toBe("")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_wrapped_internal_1")
  })

  it("ignores wrapped tool json token payload even when tagged final", () => {
    const rawChunk = {
      result: {
        response: {
          token: '{"query":"张国荣 年轻时 照片","num_results":"15"}',
          messageTag: "final",
          isThinking: false,
          responseId: "resp_wrapped_internal_2",
        },
      },
    }

    expect(extractGatewayTextDeltaFromRawChunk(rawChunk)).toBe("")
  })

  it("extracts final message from wrapped gateway response payload", () => {
    const rawChunk = {
      result: {
        response: {
          message: "最终答案",
          responseId: "resp_wrapped_3",
          cardAttachmentsJson: [],
        },
      },
    }

    expect(extractGatewayFinalMessageFromRawChunk(rawChunk)).toBe("最终答案")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_wrapped_3")
  })

  it("ignores wrapped internal relay message payload", () => {
    const rawChunk = {
      result: {
        response: {
          message: '{"message":"我已经搜集了生平资料","to":"Grok"}',
          responseId: "resp_wrapped_4",
        },
      },
    }

    expect(extractGatewayFinalMessageFromRawChunk(rawChunk)).toBe("")
    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("resp_wrapped_4")
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

  it("extracts generated images from streamingImageGenerationResponse payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/img-1/image.jpg",
          },
        },
      },
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]?.type).toBe("generated_image")
    expect(cards[0]?.image?.original).toBe("users/abc/generated/img-1/image.jpg")
  })

  it("extracts generated images from modelResponse.generatedImageUrls payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          modelResponse: {
            generatedImageUrls: [
              "users/abc/generated/img-1/image.jpg",
              "users/abc/generated/img-2/image.jpg",
            ],
          },
        },
      },
    })

    expect(cards).toHaveLength(2)
    expect(cards[0]?.type).toBe("generated_image")
    expect(cards[0]?.image?.original).toBe("users/abc/generated/img-1/image.jpg")
    expect(cards[1]?.image?.original).toBe("users/abc/generated/img-2/image.jpg")
  })

  it("extracts image card from cardAttachment.jsonData payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.tool_usage_card",
      cardAttachment: {
        jsonData:
          "{\"id\":\"card_1\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/c.jpg\",\"thumbnail\":\"https://img.test/c-thumb.jpg\",\"title\":\"sample\",\"link\":\"https://source.test\"}}",
      },
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]?.id).toBe("card_1")
    expect(cards[0]?.cardType).toBe("image_card")
    expect(cards[0]?.type).toBe("render_searched_image")
    expect(cards[0]?.image?.original).toBe("https://img.test/c.jpg")
    expect(cards[0]?.image?.link).toBe("https://source.test")
  })

  it("extracts image cards from cardAttachmentsJson array payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.completed",
      response: {
        cardAttachmentsJson: [
          "{\"id\":\"card_1\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/c.jpg\"}}",
          "{\"id\":\"card_2\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/d.jpg\"}}",
        ],
      },
    })

    expect(cards).toHaveLength(2)
    expect(cards[0]?.id).toBe("card_1")
    expect(cards[1]?.id).toBe("card_2")
  })

  it("extracts wrapped image cards from gateway result.response payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          cardAttachment: {
            jsonData:
              "{\"id\":\"card_live_1\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/live-a.jpg\"}}",
          },
          cardAttachmentsJson: [
            "{\"id\":\"card_done_1\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/done-a.jpg\"}}",
            "{\"id\":\"card_done_2\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/done-b.jpg\"}}",
          ],
        },
      },
    })

    expect(cards).toHaveLength(3)
    expect(cards.some((item) => item.id === "card_live_1")).toBe(true)
    expect(cards.some((item) => item.id === "card_done_1")).toBe(true)
    expect(cards.some((item) => item.id === "card_done_2")).toBe(true)
  })

  it("extracts image card from cardAttachmentParsed payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.tool_usage_card",
      cardAttachmentParsed: {
        id: "card_parsed_1",
        cardType: "image_card",
        image: {
          original: "https://img.test/parsed-a.jpg",
          thumbnail: "https://img.test/parsed-a-thumb.jpg",
          title: "parsed",
        },
      },
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]?.id).toBe("card_parsed_1")
    expect(cards[0]?.image?.original).toBe("https://img.test/parsed-a.jpg")
  })

  it("extracts cards from concatenated gateway json chunks", () => {
    const rawChunk =
      JSON.stringify({
        result: {
          response: {
            cardAttachment: {
              jsonData:
                "{\"id\":\"card_concat_1\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"original\":\"https://img.test/concat-a.jpg\"}}",
            },
          },
        },
      }) +
      JSON.stringify({
        result: {
          response: {
            cardAttachmentsJson: [
              {
                id: "card_concat_2",
                cardType: "image_card",
                type: "render_searched_image",
                image: {
                  original: "https://img.test/concat-b.jpg",
                },
              },
            ],
          },
        },
      })

    const cards = extractCardAttachmentsFromRawChunk(rawChunk)

    expect(cards).toHaveLength(2)
    expect(cards.some((item) => item.id === "card_concat_1")).toBe(true)
    expect(cards.some((item) => item.id === "card_concat_2")).toBe(true)
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

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "tool_result",
      result: {
        toolUsageCardId: "tool_1",
        rolloutId: "Agent 1",
        messageTag: "raw_function_result",
        webSearchResultsCount: 2,
        webSearchResults: [
          { url: "https://a.test", title: undefined, preview: undefined, favicon: undefined },
          { url: "https://b.test", title: undefined, preview: undefined, favicon: undefined },
        ],
        isThinking: false,
        responseId: "resp_1",
      },
    })
  })

  it("extracts tool result count from raw_function_result object payload", () => {
    const events = extractReasoningEventsFromRawChunk({
      type: "response.tool_usage_card",
      response_id: "resp_1",
      isThinking: false,
      messageTag: "raw_function_result",
      rolloutId: "Agent 1",
      toolUsageCardId: "tool_1",
      webSearchResults: {
        results: [{ url: "https://a.test" }, { url: "https://b.test" }, { url: "https://c.test" }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "tool_result",
      result: {
        toolUsageCardId: "tool_1",
        rolloutId: "Agent 1",
        messageTag: "raw_function_result",
        webSearchResultsCount: 3,
        webSearchResults: [
          { url: "https://a.test", title: undefined, preview: undefined, favicon: undefined },
          { url: "https://b.test", title: undefined, preview: undefined, favicon: undefined },
          { url: "https://c.test", title: undefined, preview: undefined, favicon: undefined },
        ],
        isThinking: false,
        responseId: "resp_1",
      },
    })
  })

  it("extracts wrapped ui layout from gateway result.response payload", () => {
    const events = extractReasoningEventsFromRawChunk({
      result: {
        response: {
          uiLayout: {
            reasoningUiLayout: "UNIFIED",
            willThinkLong: false,
            rolloutIds: ["Grok", "Agent 1"],
          },
          responseId: "resp_wrapped_4",
          isThinking: true,
        },
      },
    })

    expect(events).toEqual([
      {
        kind: "ui_layout",
        layout: {
          reasoningUiLayout: "UNIFIED",
          willThinkLong: false,
          effort: undefined,
          rolloutIds: ["Grok", "Agent 1"],
        },
        isThinking: true,
        responseId: "resp_wrapped_4",
      },
    ])
  })

  it("extracts wrapped tool usage from gateway result.response payload", () => {
    const events = extractReasoningEventsFromRawChunk({
      result: {
        response: {
          messageTag: "tool_usage_card",
          responseId: "resp_wrapped_5",
          rolloutId: "Agent 1",
          isThinking: true,
          toolUsageCard: {
            toolUsageCardId: "tool_wrapped_1",
            webSearch: {
              args: {
                query: "刘美贤",
              },
            },
          },
        },
      },
    })

    expect(events).toEqual([
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "tool_wrapped_1",
          toolName: "webSearch",
          args: {
            query: "刘美贤",
          },
          rolloutId: "Agent 1",
          messageTag: "tool_usage_card",
          isThinking: true,
          responseId: "resp_wrapped_5",
        },
      },
    ])
  })

  it("extracts wrapped tool result from gateway result.response payload", () => {
    const events = extractReasoningEventsFromRawChunk({
      result: {
        response: {
          messageTag: "raw_function_result",
          responseId: "resp_wrapped_6",
          rolloutId: "Agent 1",
          toolUsageCardId: "tool_wrapped_1",
          isThinking: false,
          webSearchResults: {
            results: [{ url: "https://a.test" }, { url: "https://b.test" }],
          },
        },
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: "tool_result",
      result: {
        toolUsageCardId: "tool_wrapped_1",
        rolloutId: "Agent 1",
        messageTag: "raw_function_result",
        webSearchResultsCount: 2,
        webSearchResults: [
          { url: "https://a.test", title: undefined, preview: undefined, favicon: undefined },
          { url: "https://b.test", title: undefined, preview: undefined, favicon: undefined },
        ],
        isThinking: false,
        responseId: "resp_wrapped_6",
      },
    })
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
