import { describe, expect, it } from "bun:test"
import {
  extractCardAttachmentsFromRawChunk,
  extractDeepSearchResearchFromRawChunk,
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractGeneratedImageModeratedFromRawChunk,
  extractInlineCitationsFromText,
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

  it("extracts generated image asset metadata from streamingImageGenerationResponse payload", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/25da98c5-a40f-426f-86f2-5713538aa1b1/image.jpg",
            assetId: "25da98c5-a40f-426f-86f2-5713538aa1b1",
            asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            raw_url: "https://assets.grok.com/users/abc/generated/25da98c5-a40f-426f-86f2-5713538aa1b1/image.jpg",
            url_expires_at: "2026-03-02T10:00:00Z",
          },
        },
      },
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]?.assetId).toBe("25da98c5-a40f-426f-86f2-5713538aa1b1")
    expect(cards[0]?.asset_id).toBe("image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(cards[0]?.rawUrl).toBe(
      "https://assets.grok.com/users/abc/generated/25da98c5-a40f-426f-86f2-5713538aa1b1/image.jpg"
    )
    expect(cards[0]?.urlExpiresAt).toBe(new Date("2026-03-02T10:00:00Z").toISOString())
  })

  it("ignores intermediate streaming generated image chunks (progress < 100)", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/img-1-part-0/image.jpg",
            progress: 50,
            moderated: false,
            imageIndex: 0,
          },
        },
      },
    })

    expect(cards).toHaveLength(0)
  })

  it("ignores intermediate streaming generated image chunks even when asset id exists", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/img-1/image.jpg",
            asset_id: "image_deadbeef",
            progress: 60,
            moderated: false,
          },
        },
      },
    })

    expect(cards).toHaveLength(0)
  })

  it("ignores moderated generated image chunks", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/img-1/image.jpg",
            progress: 100,
            moderated: true,
            imageIndex: 0,
          },
        },
      },
    })

    expect(cards).toHaveLength(0)
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

  it("extracts generated image metadata from indexed summary arrays", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      result: {
        response: {
          modelResponse: {
            generatedImageUrls: [
              "https://s3.bitiful.net/grok/assets/image/2026/03/a.jpg?X-Amz-Date=20260302T060000Z&X-Amz-Expires=7200",
              "https://s3.bitiful.net/grok/assets/image/2026/03/b.jpg?X-Amz-Date=20260302T060100Z&X-Amz-Expires=7200",
            ],
            generatedImageRawUrls: [
              "https://assets.grok.com/users/u-1/generated/image_a/image.jpg",
              "https://assets.grok.com/users/u-1/generated/image_b/image.jpg",
            ],
            generatedImageAssetIds: [
              "image_a",
              "image_b",
            ],
            generatedImageURLExpiresAt: [
              1772436000,
              "2026-03-02T08:01:00Z",
            ],
          },
        },
      },
    })

    expect(cards).toHaveLength(2)
    expect(cards[0]?.image?.original).toContain("/a.jpg")
    expect(cards[0]?.asset_id).toBe("image_a")
    expect(cards[0]?.rawUrl).toBe("https://assets.grok.com/users/u-1/generated/image_a/image.jpg")
    expect(cards[0]?.urlExpiresAt).toBe(new Date(1772436000 * 1000).toISOString())
    expect(cards[1]?.asset_id).toBe("image_b")
    expect(cards[1]?.urlExpiresAt).toBe(new Date("2026-03-02T08:01:00Z").toISOString())
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

  it("drops generated image cards from response.output_item.added", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.output_item.added",
      cardAttachmentParsed: {
        id: "card_added_generated",
        cardType: "image_card",
        type: "generated_image",
        image: {
          original: "https://assets.grok.com/users/u-1/generated/g-1/image.jpg",
        },
      },
    })

    expect(cards).toHaveLength(0)
  })

  it("drops generated image cardAttachment when progress is incomplete", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.output_item.done",
      cardAttachmentParsed: {
        id: "card_progress_partial",
        cardType: "image_card",
        type: "generated_image",
        progress: 42,
        image: {
          original: "https://assets.grok.com/users/u-1/generated/g-1/image.jpg",
        },
      },
    })

    expect(cards).toHaveLength(0)
  })

  it("drops moderated generated image cardAttachment", () => {
    const cards = extractCardAttachmentsFromRawChunk({
      type: "response.output_item.done",
      cardAttachmentParsed: {
        id: "card_generated_moderated",
        cardType: "image_card",
        type: "generated_image",
        moderated: true,
        image: {
          original: "https://assets.grok.com/users/u-1/generated/g-1/image.jpg",
        },
      },
    })

    expect(cards).toHaveLength(0)
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

describe("extractGeneratedImageModeratedFromRawChunk", () => {
  it("detects moderated image chunk", () => {
    const moderated = extractGeneratedImageModeratedFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/img-1/image.jpg",
            progress: 100,
            moderated: true,
          },
        },
      },
    })

    expect(moderated).toBe(true)
  })

  it("returns false for normal image chunk", () => {
    const moderated = extractGeneratedImageModeratedFromRawChunk({
      result: {
        response: {
          streamingImageGenerationResponse: {
            imageUrl: "users/abc/generated/img-1/image.jpg",
            progress: 100,
            moderated: false,
          },
        },
      },
    })

    expect(moderated).toBe(false)
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

describe("extractInlineCitationsFromText", () => {
  it("extracts inline citation rows from grok render tags", () => {
    const rows = extractInlineCitationsFromText(
      [
        "正文",
        '<grok:render card_id="c1" card_type="citation_card" type="render_inline_citation">',
        '<argument name="citation_id">6</argument>',
        "</grok:render>",
      ].join("\n")
    )

    expect(rows).toEqual([
      {
        cardId: "c1",
        citationId: "6",
        url: undefined,
      },
    ])
  })
})

describe("extractDeepSearchResearchFromRawChunk", () => {
  it("extracts research payload from x_grok.research", () => {
    const research = extractDeepSearchResearchFromRawChunk({
      type: "response.completed",
      response: {
        x_grok: {
          research: {
            request_metadata: {
              model: "grok-4",
              mode: "MODEL_MODE_EXPERT",
              effort: "HIGH",
            },
            ui_layout: {
              reasoningUiLayout: "UNIFIED",
              willThinkLong: true,
              effort: "HIGH",
              rolloutIds: ["Grok", "Agent 1"],
            },
            thinking_start_time: "2026-03-03T10:00:00Z",
            thinking_end_time: "2026-03-03T10:00:09Z",
            citation_cards: [{ card_id: "c1", card_type: "citation_card", url: "https://en.wikipedia.org/wiki/Eileen_Gu" }],
            inline_citations: [{ card_id: "c1", citation_id: "6" }],
            steps: [
              { tags: ["header"], text: ["挖掘国籍细节"] },
              { tags: ["summary"], text: ["谷爱凌国籍争议及中美双重身份，引发公众讨论。"] },
            ],
          },
        },
      },
    })

    expect(research.requestMetadata?.model).toBe("grok-4")
    expect(research.uiLayout?.reasoningUiLayout).toBe("UNIFIED")
    expect(research.thinkingStartTime).toBe(new Date("2026-03-03T10:00:00Z").toISOString())
    expect(research.thinkingEndTime).toBe(new Date("2026-03-03T10:00:09Z").toISOString())
    expect(research.citationCards).toEqual([
      {
        cardId: "c1",
        cardType: "citation_card",
        url: "https://en.wikipedia.org/wiki/Eileen_Gu",
      },
    ])
    expect(research.inlineCitations).toEqual([
      {
        cardId: "c1",
        citationId: "6",
        url: undefined,
      },
    ])
    expect(research.details).toEqual([
      {
        title: "挖掘国籍细节",
        bullets: ["谷爱凌国籍争议及中美双重身份，引发公众讨论。"],
      },
    ])
  })

  it("extracts citation cards from stream cardAttachment payload", () => {
    const research = extractDeepSearchResearchFromRawChunk({
      result: {
        response: {
          cardAttachment: {
            jsonData:
              "{\"id\":\"card_11\",\"cardType\":\"citation_card\",\"type\":\"render_inline_citation\",\"url\":\"https://time.com/6148188/eileen-gus-identity\"}",
          },
          modelResponse: {
            steps: [
              {
                tags: ["header"],
                text: ["挖掘国籍细节"],
              },
              {
                tags: ["summary"],
                text: ["她出生在美国，母亲是中国人，2019年宣布加入中国国籍。"],
              },
            ],
          },
        },
      },
    })

    expect(research.citationCards).toEqual([
      {
        cardId: "card_11",
        cardType: "citation_card",
        url: "https://time.com/6148188/eileen-gus-identity",
      },
    ])
    expect(research.details).toEqual([
      {
        title: "挖掘国籍细节",
        bullets: ["她出生在美国，母亲是中国人，2019年宣布加入中国国籍。"],
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
