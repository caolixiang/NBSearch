import { describe, expect, it } from "bun:test"
import { GatewayStreamAccumulator, readReasoningEventResponseId } from "./gateway-stream-accumulator"

describe("GatewayStreamAccumulator", () => {
  it("emits synthetic tool_result when thinking ends without raw_function_result", () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")

    const batch = accumulator.processJsonSegments(
      [
        JSON.stringify({
          type: "response.tool_usage_card",
          response_id: "resp_stream_1",
          isThinking: true,
          messageTag: "tool_usage_card",
          rolloutId: "Agent 1",
          toolUsageCard: {
            toolUsageCardId: "tool_1",
            webSearch: {
              args: { query: "hello" },
            },
          },
        }),
        JSON.stringify({
          result: {
            response: {
              isThinking: false,
            },
          },
        }),
      ],
      1234
    )

    expect(batch.responseId).toBe("resp_stream_1")
    expect(batch.delta).toBe("")
    expect(batch.reasoningDetails).toHaveLength(2)
    expect(batch.reasoningDetails[0]?.kind).toBe("tool_usage")
    expect(batch.reasoningDetails[1]).toEqual({
      kind: "tool_result",
      result: {
        toolUsageCardId: "tool_1",
        isThinking: false,
      },
    })

    const snapshot = accumulator.snapshotCompletionState()
    expect(snapshot.collectedReasoningEvents).toHaveLength(2)
    expect(snapshot.reasoningStartedAtMs).toBe(1234)
    expect(snapshot.reasoningEndedAtMs).toBe(1234)
  })

  it("deduplicates generated image cards and filters narration delta once image cards appear", () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")

    const batch = accumulator.processJsonSegments(
      [
        JSON.stringify({
          type: "response.output_item.done",
          cardAttachmentParsed: {
            id: "card_part_1",
            cardType: "image_card",
            type: "generated_image",
            image: {
              original: "users/abc/generated/demo-part-0/image.jpg",
            },
          },
        }),
        JSON.stringify({
          type: "response.output_item.done",
          cardAttachmentParsed: {
            id: "card_final_1",
            cardType: "image_card",
            type: "generated_image",
            image: {
              original: "users/abc/generated/demo/image.jpg",
            },
          },
        }),
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "Here are two images.",
        }),
      ],
      2000
    )

    expect(batch.delta).toBe("")
    const snapshot = accumulator.snapshotCompletionState()
    expect(snapshot.assistantText).toBe("")
    expect(snapshot.hasStructuredGeneratedImages).toBe(true)
    expect(snapshot.collectedCards).toHaveLength(1)
    expect(snapshot.collectedCards[0]?.id).toBe("card_final_1")
  })

  it("accumulates response id, title, web search meta and final message", () => {
    const accumulator = new GatewayStreamAccumulator("http://127.0.0.1:8787/v1/responses")

    const batch = accumulator.processJsonSegments(
      [
        JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_stream_2",
          },
          title: {
            newTitle: "上游标题",
          },
        }),
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "Hello",
        }),
        JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "web_search",
            arguments: "{\"query\":\"hello world\",\"num_results\":10}",
          },
        }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_stream_2",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Hello world",
                  },
                ],
              },
            ],
          },
        }),
      ],
      3000
    )

    expect(batch.delta).toBe("Hello")
    expect(batch.responseId).toBe("resp_stream_2")
    expect(accumulator.shouldRetryIdleTimeout()).toBe(false)

    const snapshot = accumulator.snapshotCompletionState()
    expect(snapshot.upstreamConversationTitle).toBe("上游标题")
    expect(snapshot.assistantText).toBe("Hello")
    expect(snapshot.gatewayFinalMessage).toBe("Hello world")
    expect(snapshot.collectedWebSearchMeta).toEqual([{ query: "hello world", numResults: 10 }])
  })
})

describe("readReasoningEventResponseId", () => {
  it("reads response ids from different reasoning event shapes", () => {
    expect(
      readReasoningEventResponseId({
        kind: "ui_layout",
        layout: { rolloutIds: [] },
        responseId: "resp_layout_1",
      })
    ).toBe("resp_layout_1")
    expect(
      readReasoningEventResponseId({
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "tool_usage_1",
          toolName: "web_search",
          args: {},
          responseId: "resp_usage_1",
        },
      })
    ).toBe("resp_usage_1")
    expect(
      readReasoningEventResponseId({
        kind: "tool_result",
        result: {
          toolUsageCardId: "tool_result_1",
          responseId: "resp_result_1",
        },
      })
    ).toBe("resp_result_1")
  })
})
