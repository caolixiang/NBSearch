import { describe, expect, it } from "bun:test"
import {
  extractDeepSearchResearchFromRawChunk,
  extractInlineCitationsFromText,
} from "./chunk-parsers"

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
    expect(research.steps).toEqual([
      {
        tags: ["header"],
        title: undefined,
        text: ["挖掘国籍细节"],
        toolUsageCardIds: undefined,
      },
      {
        tags: ["summary"],
        title: undefined,
        text: ["谷爱凌国籍争议及中美双重身份，引发公众讨论。"],
        toolUsageCardIds: undefined,
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
    expect(research.steps).toEqual([
      {
        tags: ["header"],
        title: undefined,
        text: ["挖掘国籍细节"],
        toolUsageCardIds: undefined,
      },
      {
        tags: ["summary"],
        title: undefined,
        text: ["她出生在美国，母亲是中国人，2019年宣布加入中国国籍。"],
        toolUsageCardIds: undefined,
      },
    ])
  })

  it("extracts step tool usage metadata from toolUsageCards and toolUsageResults", () => {
    const research = extractDeepSearchResearchFromRawChunk({
      x_grok: {
        research: {
          steps: [
            {
              tags: ["tool_usage_card"],
              text: [
                "<xai:tool_usage_card>\n  <xai:tool_usage_card_id>card_1</xai:tool_usage_card_id>\n  <xai:tool_name>web_search</xai:tool_name>\n  <xai:tool_args><![CDATA[{\"query\":\"Gu Ailing nationality controversy\",\"num_results\":20}]]></xai:tool_args>\n</xai:tool_usage_card>",
              ],
              toolUsageCards: [
                {
                  toolUsageCardId: "card_1",
                  webSearch: {
                    args: {
                      query: "Gu Ailing nationality controversy",
                    },
                  },
                },
                {
                  toolUsageCardId: "card_x_1",
                  x_keyword_search: {
                    args: {
                      query: "谷爱凌 国籍",
                      limit: 10,
                    },
                  },
                },
              ],
              toolUsageResults: [
                {
                  toolUsageCardId: "card_1",
                  webSearchResults: {
                    results: [
                      {
                        url: "https://example.com/a",
                        title: "Example A",
                      },
                    ],
                  },
                },
                {
                  toolUsageCardId: "card_x_1",
                  xSearchResults: {
                    results: [
                      {
                        username: "Guoshuai777777",
                        name: "郭帅",
                        text: "美国应该取消了杨润和吴征的美国国籍！",
                        createTime: "2026-03-04T00:00:00Z",
                        postId: "2029999999999999999",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    })

    expect(research.steps).toEqual([
      {
        tags: ["tool_usage_card"],
        title: undefined,
        text: [
          "<xai:tool_usage_card>\n  <xai:tool_usage_card_id>card_1</xai:tool_usage_card_id>\n  <xai:tool_name>web_search</xai:tool_name>\n  <xai:tool_args><![CDATA[{\"query\":\"Gu Ailing nationality controversy\",\"num_results\":20}]]></xai:tool_args>\n</xai:tool_usage_card>",
        ],
        toolUsageCardIds: ["card_1", "card_x_1"],
        toolUsages: [
          {
            toolUsageCardId: "card_1",
            toolName: "web_search",
            args: {
              query: "Gu Ailing nationality controversy",
              num_results: 20,
            },
            webSearchResults: [
              {
                url: "https://example.com/a",
                title: "Example A",
                preview: undefined,
                favicon: undefined,
              },
            ],
          },
          {
            toolUsageCardId: "card_x_1",
            toolName: "x_keyword_search",
            args: {
              query: "谷爱凌 国籍",
              limit: 10,
            },
            webSearchResults: [
              {
                kind: "x_post",
                title: "郭帅 @Guoshuai777777",
                url: "https://x.com/Guoshuai777777/status/2029999999999999999",
                preview: "美国应该取消了杨润和吴征的美国国籍！",
                favicon: undefined,
                authorName: "郭帅",
                authorHandle: "Guoshuai777777",
                publishedAt: "2026-03-04T00:00:00Z",
                postId: "2029999999999999999",
              },
            ],
          },
        ],
      },
    ])
  })

  it("extracts deepsearch steps from streaming messageTag header/summary tokens", () => {
    const header = extractDeepSearchResearchFromRawChunk({
      result: {
        response: {
          messageTag: "header",
          token: "Exploring China's oil sources",
          messageStepId: 1,
          responseId: "resp_deep_2",
        },
      },
    })
    const summary = extractDeepSearchResearchFromRawChunk({
      result: {
        response: {
          messageTag: "summary",
          token: "- Imports reached record levels in 2025.\n- Top sources include Russia and Saudi Arabia.",
          messageStepId: 1,
          responseId: "resp_deep_2",
        },
      },
    })

    expect(header.steps).toEqual([
      {
        tags: ["header"],
        title: "Exploring China's oil sources",
        text: ["Exploring China's oil sources"],
        toolUsageCardIds: undefined,
      },
    ])
    expect(summary.steps).toEqual([
      {
        tags: ["summary"],
        title: undefined,
        text: ["Imports reached record levels in 2025.", "Top sources include Russia and Saudi Arabia."],
        toolUsageCardIds: undefined,
        toolUsages: undefined,
      },
    ])
  })
})

