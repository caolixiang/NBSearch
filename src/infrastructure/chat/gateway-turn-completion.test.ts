import { describe, expect, it } from "bun:test"
import type { ChatCardAttachmentPayload } from "../../domain/chat/types"
import { buildCompletedGatewayTurn, mergeResearchPayload } from "./gateway-turn-completion"

describe("mergeResearchPayload", () => {
  it("deduplicates citation and inline citation rows", () => {
    const merged = mergeResearchPayload(
      {
        citationCards: [{ cardId: "c1", url: "https://a.test" }],
        inlineCitations: [{ cardId: "c1", citationId: "1", url: "https://a.test" }],
      },
      {
        citationCards: [{ cardId: "c1", url: "https://a.test" }, { cardId: "c2", url: "https://b.test" }],
        inlineCitations: [
          { cardId: "c1", citationId: "1", url: "https://a.test" },
          { cardId: "c2", citationId: "2", url: "https://b.test" },
        ],
      }
    )

    expect(merged?.citationCards).toEqual([
      { cardId: "c1", url: "https://a.test" },
      { cardId: "c2", url: "https://b.test" },
    ])
    expect(merged?.inlineCitations).toEqual([
      { cardId: "c1", citationId: "1", url: "https://a.test" },
      { cardId: "c2", citationId: "2", url: "https://b.test" },
    ])
  })
})

describe("buildCompletedGatewayTurn", () => {
  it("prefers research duration, merges citations, and resolves upstream title", async () => {
    const cards: ChatCardAttachmentPayload[] = [
      {
        id: "citation_card_1",
        cardType: "citation_card",
        url: "https://cnn.com/example",
        image: { link: "https://cnn.com/example" },
      },
    ]

    const completion = await buildCompletedGatewayTurn({
      state: {
        upstreamConversationTitle: "上游标题",
        assistantText: "<think>推理</think>",
        gatewayFinalMessage:
          '正文\n<grok:render card_id="citation_card_1" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">6</argument></grok:render>',
        collectedWebSearchMeta: [{ query: "Eileen Gu", numResults: 12 }],
        collectedCards: cards,
        collectedReasoningEvents: [
          {
            kind: "tool_usage",
            usage: {
              toolUsageCardId: "tool_1",
              toolName: "web_search",
              args: { query: "Eileen Gu" },
            },
          },
        ],
        collectedResearch: {
          thinkingStartTime: "2026-03-08T00:00:00Z",
          thinkingEndTime: "2026-03-08T00:00:05Z",
        },
        hasStructuredGeneratedImages: false,
        hasModeratedGeneratedImages: false,
        reasoningStartedAtMs: 1,
        reasoningEndedAtMs: 2,
      },
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      hydrateGeneratedImageCards: async () => {},
      gatewayResponseId: "resp_completed_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      previousResponseId: "resp_prev_1",
      currentTitle: "现有标题",
      fallbackTitle: "兜底标题",
      streamStartedAt: Date.parse("2026-03-08T00:00:00Z"),
      commitTime: Date.parse("2026-03-08T00:00:09Z"),
    })

    expect(completion.resolvedTitle).toBe("上游标题")
    expect(completion.result.assistantMessage.reasoningDurationSeconds).toBe(5)
    expect(completion.result.assistantMessage.responseId).toBe("resp_completed_1")
    expect(completion.result.assistantMessage.previousResponseId).toBe("resp_prev_1")
    expect(completion.result.assistantMessage.research?.citationCards).toEqual([
      {
        cardId: "citation_card_1",
        cardType: "citation_card",
        url: "https://cnn.com/example",
      },
    ])
    expect(completion.result.assistantMessage.research?.inlineCitations).toEqual([
      {
        cardId: "citation_card_1",
        citationId: "6",
      },
    ])
    expect(completion.result.assistantMessage.content).toContain("<tool-meta>")
    expect(completion.result.anchors).toEqual({
      sessionId: "sess_1",
      conversationId: "conv_1",
      lastResponseId: "resp_completed_1",
    })
  })

  it("renders structured generated images and moderated notice before fallback text", async () => {
    const generatedUrl = "https://assets.grok.com/users/u-1/generated/demo-asset/image.jpg"

    const completion = await buildCompletedGatewayTurn({
      state: {
        upstreamConversationTitle: "",
        assistantText: "这段文字不应保留",
        gatewayFinalMessage: "最终文本也不应保留",
        collectedWebSearchMeta: [],
        collectedCards: [
          {
            id: "generated_card_1",
            cardType: "image_card",
            type: "generated_image",
            url: generatedUrl,
            image: { original: generatedUrl },
          },
        ],
        collectedReasoningEvents: [],
        collectedResearch: undefined,
        hasStructuredGeneratedImages: true,
        hasModeratedGeneratedImages: true,
        reasoningStartedAtMs: null,
        reasoningEndedAtMs: null,
      },
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      hydrateGeneratedImageCards: async () => {},
      gatewayResponseId: "resp_completed_2",
      sessionId: "sess_2",
      conversationId: "conv_2",
      previousResponseId: "",
      currentTitle: "",
      fallbackTitle: "图片标题",
      streamStartedAt: 1000,
      commitTime: 4000,
    })

    expect(completion.resolvedTitle).toBe("图片标题")
    expect(completion.result.assistantMessage.content).toContain("![Generated Image]")
    expect(completion.result.assistantMessage.content).toContain("内容已管理。请尝试一个不同的想法。")
    expect(completion.result.assistantMessage.content).not.toContain("这段文字不应保留")
    expect(completion.result.assistantMessage.content).not.toContain("最终文本也不应保留")
    expect(completion.result.assistantMessage.reasoningDurationSeconds).toBeUndefined()
  })

  it("falls back to final message and keeps existing title when upstream title is missing", async () => {
    const completion = await buildCompletedGatewayTurn({
      state: {
        upstreamConversationTitle: "",
        assistantText: "",
        gatewayFinalMessage: "最终答案正文",
        collectedWebSearchMeta: [],
        collectedCards: [],
        collectedReasoningEvents: [],
        collectedResearch: undefined,
        hasStructuredGeneratedImages: false,
        hasModeratedGeneratedImages: false,
        reasoningStartedAtMs: null,
        reasoningEndedAtMs: null,
      },
      apiUrl: "http://127.0.0.1:8787/v1/responses",
      hydrateGeneratedImageCards: async () => {},
      gatewayResponseId: "resp_completed_3",
      sessionId: "sess_3",
      conversationId: "conv_3",
      previousResponseId: "resp_prev_3",
      currentTitle: "现有标题",
      fallbackTitle: "兜底标题",
      streamStartedAt: 1000,
      commitTime: 3000,
    })

    expect(completion.resolvedTitle).toBe("现有标题")
    expect(completion.result.assistantMessage.content).toContain("最终答案正文")
    expect(completion.result.assistantMessage.reasoningDurationSeconds).toBeUndefined()
  })
})
