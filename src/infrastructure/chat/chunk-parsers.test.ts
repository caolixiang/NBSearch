import { describe, expect, it } from "bun:test"
import {
  extractGatewayFinalMessageFromRawChunk,
  extractGatewayResponseIdFromRawChunk,
  extractGatewayTextDeltaFromRawChunk,
  extractResponseNewTitleFromRawChunk,
  extractWebSearchToolMetaFromRawChunk,
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

  it("extracts string title from conversation payload and strips eos", () => {
    const title = extractResponseNewTitleFromRawChunk({
      result: {
        conversation: {
          title: "友好问候<eos>",
        },
      },
    })

    expect(title).toBe("友好问候")
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

  it("extracts uuid response id from modelResponse payload", () => {
    const rawChunk = {
      result: {
        response: {
          modelResponse: {
            responseId: "6f1e2fb9-5cd8-4afd-81d1-35de913cb26a",
          },
        },
      },
    }

    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("6f1e2fb9-5cd8-4afd-81d1-35de913cb26a")
  })

  it("prefers explicit modelResponse.responseId over wrapped bare id", () => {
    const rawChunk = {
      result: {
        response: {
          id: "c1ec99a3-f9c3-44af-8a1c-597ef5e4a9a9",
          modelResponse: {
            responseId: "21ba32de-5d23-4d9b-8764-222990a10c12",
          },
        },
      },
    }

    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("21ba32de-5d23-4d9b-8764-222990a10c12")
  })

  it("ignores wrapped userResponse ids when assistant response has not started", () => {
    const rawChunk = {
      result: {
        response: {
          userResponse: {
            responseId: "0bf30fa6-def6-419f-bc85-10d53de4dde1",
          },
          responseId: "0bf30fa6-def6-419f-bc85-10d53de4dde1",
        },
      },
    }

    expect(extractGatewayResponseIdFromRawChunk(rawChunk)).toBe("")
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


describe("resolveConversationTitle", () => {
  it("prefers upstream newTitle", () => {
    const title = resolveConversationTitle("Friendly greeting", "")
    expect(title).toBe("Friendly greeting")
  })

  it("keeps existing title when upstream title is missing", () => {
    const title = resolveConversationTitle("", "已存在标题")
    expect(title).toBe("已存在标题")
  })

  it("ignores placeholder title and keeps existing title", () => {
    const title = resolveConversationTitle("New conversation", "已存在标题")
    expect(title).toBe("已存在标题")
  })

  it("keeps empty title when both upstream and existing titles are missing", () => {
    const title = resolveConversationTitle("", "")
    expect(title).toBe("")
  })
})
