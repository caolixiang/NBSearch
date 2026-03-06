import { describe, expect, it } from "bun:test"
import type { ChatDeepSearchDetail, ChatDeepSearchResearchStep, ChatReasoningEventDetail } from "@/domain/chat/types"
import {
  buildDeepSearchGroupedSections,
  buildDeepSearchLegacyTimeline,
  buildDeepSearchTimeline,
  buildStructuredReasoningSummary,
  collectRolloutAgents,
  hasDeepSearchContent,
  mergeReasoningRolloutIds,
} from "./structured-reasoning"

describe("buildStructuredReasoningSummary toolChain", () => {
  it("aggregates tool usage and completion counts by toolName", () => {
    const events: ChatReasoningEventDetail[] = [
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "u1",
          toolName: "webSearch",
          args: { query: "Eileen Gu nationality controversy" },
        },
      },
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "u2",
          toolName: "webSearch",
          args: { query: "谷爱凌国籍问题" },
        },
      },
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "u3",
          toolName: "browsePage",
          args: { url: "https://en.wikipedia.org/wiki/Eileen_Gu" },
        },
      },
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "u1",
          webSearchResultsCount: 10,
        },
      },
    ]

    const summary = buildStructuredReasoningSummary(events)
    expect(summary.toolChain).toEqual([
      {
        toolName: "webSearch",
        usageCount: 2,
        completedCount: 1,
        runningCount: 1,
      },
      {
        toolName: "browsePage",
        usageCount: 1,
        completedCount: 0,
        runningCount: 1,
      },
    ])
  })

  it("does not include chatroom_send in toolChain counters", () => {
    const events: ChatReasoningEventDetail[] = [
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "c1",
          toolName: "chatroom_send",
          args: { message: "Agent internal note" },
        },
      },
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "c1",
        },
      },
    ]

    const summary = buildStructuredReasoningSummary(events)
    expect(summary.toolChain).toHaveLength(0)
    expect(summary.entries).toHaveLength(1)
  })
})

describe("buildDeepSearchGroupedSections", () => {
  it("groups deepsearch steps by header and keeps tool usage in sequence", () => {
    const steps: ChatDeepSearchResearchStep[] = [
      {
        tags: ["header"],
        text: ["挖掘国籍细节"],
      },
      {
        tags: ["summary"],
        text: ["先确认争议主线。"],
      },
      {
        tags: ["tool_usage_card"],
        text: [],
        toolUsageCardIds: ["tool_card_1"],
      },
    ]
    const events: ChatReasoningEventDetail[] = [
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "tool_card_1",
          toolName: "web_search",
          args: {
            query: "Gu Ailing nationality controversy",
          },
        },
      },
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "tool_card_1",
          webSearchResultsCount: 20,
        },
      },
    ]

    const summary = buildStructuredReasoningSummary(events)
    const grouped = buildDeepSearchGroupedSections(steps, summary.entries)

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.title).toBe("挖掘国籍细节")
    expect(grouped[0]?.items).toHaveLength(2)
    expect(grouped[0]?.items[0]?.kind).toBe("summary")
    expect(grouped[0]?.items[1]?.kind).toBe("tool")
    if (grouped[0]?.items[1]?.kind === "tool") {
      expect(grouped[0].items[1].entries[0]?.toolUsageCardId).toBe("tool_card_1")
    }
  })

  it("creates tool entries from step toolUsages when reasoning events are missing", () => {
    const steps: ChatDeepSearchResearchStep[] = [
      {
        tags: ["header"],
        text: ["挖掘国籍细节"],
      },
      {
        tags: ["tool_usage_card"],
        text: [
          "<xai:tool_usage_card>...</xai:tool_usage_card>",
        ],
        toolUsageCardIds: ["tool_card_only_steps"],
        toolUsages: [
          {
            toolUsageCardId: "tool_card_only_steps",
            toolName: "web_search",
            args: {
              query: "Gu Ailing nationality controversy",
            },
            webSearchResults: [
              {
                url: "https://example.com/a",
                title: "Example A",
              },
            ],
          },
        ],
      },
    ]

    const grouped = buildDeepSearchGroupedSections(steps, [])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.title).toBe("挖掘国籍细节")
    expect(grouped[0]?.items).toHaveLength(1)
    expect(grouped[0]?.items[0]?.kind).toBe("tool")
    if (grouped[0]?.items[0]?.kind === "tool") {
      expect(grouped[0].items[0].entries).toHaveLength(1)
      expect(grouped[0].items[0].entries[0]?.text).toBe("Gu Ailing nationality controversy")
      expect(grouped[0].items[0].entries[0]?.resultsCount).toBe(1)
      expect(grouped[0].items[0].entries[0]?.webSearchResults?.[0]?.url).toBe("https://example.com/a")
    }
  })
})

describe("buildDeepSearchTimeline", () => {
  it("keeps deepsearch timeline order and filters xai xml rows", () => {
    const steps: ChatDeepSearchResearchStep[] = [
      {
        tags: ["header"],
        text: ["Exploring China's oil sources"],
      },
      {
        tags: ["summary"],
        text: [
          "- China's oil mainly comes from domestic fields and imports from the Middle East.",
          "<xai:tool_usage_card>",
          "  <xai:tool_usage_card_id>tool_card_1</xai:tool_usage_card_id>",
          "</xai:tool_usage_card>",
          "- Prioritizing key info on domestic production.",
        ],
      },
      {
        tags: ["tool_usage_card"],
        text: [
          "<xai:tool_usage_card>\n  <xai:tool_usage_card_id>tool_card_1</xai:tool_usage_card_id>\n</xai:tool_usage_card>",
        ],
        toolUsageCardIds: ["tool_card_1"],
        toolUsages: [
          {
            toolUsageCardId: "tool_card_1",
            toolName: "web_search",
            args: {
              query: "China's oil sources imports domestic production 2025 2026",
              num_results: 20,
            },
          },
        ],
      },
    ]

    const timeline = buildDeepSearchTimeline(steps, [])
    expect(timeline).toHaveLength(2)
    expect(timeline[0]?.kind).toBe("thought")
    expect(timeline[1]?.kind).toBe("tool")
    if (timeline[0]?.kind === "thought") {
      expect(timeline[0].title).toBe("Exploring China's oil sources")
      expect(timeline[0].bullets).toEqual([
        "China's oil mainly comes from domestic fields and imports from the Middle East.",
        "Prioritizing key info on domestic production.",
      ])
      expect(timeline[0].bullets.join(" ")).not.toContain("<xai:")
    }
    if (timeline[1]?.kind === "tool") {
      expect(timeline[1].entry.text).toBe("China's oil sources imports domestic production 2025 2026")
      expect(timeline[1].entry.resultsCount).toBe(20)
    }
  })
})

describe("buildDeepSearchLegacyTimeline", () => {
  it("builds timeline from legacy details when steps are missing", () => {
    const details: ChatDeepSearchDetail[] = [
      {
        title: "Exploring China's oil sources",
        bullets: [
          "- China's oil mainly comes from domestic fields and imports from the Middle East.",
          "<xai:tool_usage_card>",
          "  <xai:tool_usage_card_id>legacy_1</xai:tool_usage_card_id>",
          "</xai:tool_usage_card>",
        ],
      },
      {
        title: "Detailing domestic oil production",
        bullets: ["- Domestic output hit 215 million tonnes in 2025."],
      },
    ]
    const events: ChatReasoningEventDetail[] = [
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "legacy_1",
          toolName: "web_search",
          args: { query: "China's oil sources imports domestic production 2025 2026", num_results: 20 },
        },
      },
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "legacy_1",
          webSearchResultsCount: 20,
        },
      },
    ]
    const summary = buildStructuredReasoningSummary(events)
    const timeline = buildDeepSearchLegacyTimeline(details, summary.entries)

    expect(timeline.length).toBeGreaterThanOrEqual(3)
    expect(timeline[0]?.kind).toBe("thought")
    expect(timeline[1]?.kind).toBe("tool")
    if (timeline[0]?.kind === "thought") {
      expect(timeline[0].title).toBe("Exploring China's oil sources")
      expect(timeline[0].bullets.join(" ")).not.toContain("<xai:")
    }
    if (timeline[1]?.kind === "tool") {
      expect(timeline[1].entry.text).toBe("China's oil sources imports domestic production 2025 2026")
      expect(timeline[1].entry.resultsCount).toBe(20)
    }
  })

  it("hydrates legacy x-search result count from xml detail title tool args", () => {
    const details: ChatDeepSearchDetail[] = [
      {
        title:
          "<xai:tool_usage_card>\n  <xai:tool_usage_card_id>x_legacy_1</xai:tool_usage_card_id>\n  <xai:tool_name>x_keyword_search</xai:tool_name>\n  <xai:tool_args><![CDATA[{\"query\":\"中国石油进口 伊朗 委内瑞拉 占比\",\"limit\":10}]]></xai:tool_args>\n</xai:tool_usage_card>",
        bullets: [],
      },
      {
        title: "整合 X 观点",
        bullets: ["- 讨论集中于供给冲击与替代来源。"],
      },
    ]
    const events: ChatReasoningEventDetail[] = [
      {
        kind: "tool_usage",
        usage: {
          toolUsageCardId: "x_legacy_1",
          toolName: "xSearch",
          args: { query: "中国石油进口 伊朗 委内瑞拉 占比" },
        },
      },
      {
        kind: "tool_result",
        result: {
          toolUsageCardId: "x_legacy_1",
        },
      },
    ]
    const summary = buildStructuredReasoningSummary(events)
    const timeline = buildDeepSearchLegacyTimeline(details, summary.entries)
    const toolItems = timeline.filter((item) => item.kind === "tool")

    expect(toolItems).toHaveLength(1)
    if (toolItems[0]?.kind === "tool") {
      expect(toolItems[0].entry.toolName).toBe("xSearch")
      expect(toolItems[0].entry.resultsCount).toBe(10)
      expect(toolItems[0].entry.text).toBe("中国石油进口 伊朗 委内瑞拉 占比")
    }
  })

  it("drops legacy thought cards whose title is pure xai xml", () => {
    const details: ChatDeepSearchDetail[] = [
      {
        title:
          "<xai:tool_usage_card>\n  <xai:tool_usage_card_id>legacy_xml_1</xai:tool_usage_card_id>\n</xai:tool_usage_card>",
        bullets: [],
      },
      {
        title: "编译2025数据",
        bullets: ["- 核对主要进口来源与占比。"],
      },
    ]

    const timeline = buildDeepSearchLegacyTimeline(details, [])
    const thoughtItems = timeline.filter((item) => item.kind === "thought")

    expect(thoughtItems).toHaveLength(1)
    if (thoughtItems[0]?.kind === "thought") {
      expect(thoughtItems[0].title).toBe("编译2025数据")
      expect(thoughtItems[0].title).not.toContain("<xai:")
    }
  })
})

describe("hasDeepSearchContent", () => {
  it("returns false when only generic reasoning entries exist without deepsearch research payload", () => {
    expect(hasDeepSearchContent(undefined)).toBe(false)
    expect(hasDeepSearchContent({ steps: [], details: [] })).toBe(false)
  })

  it("returns true when deepsearch details or steps exist", () => {
    expect(
      hasDeepSearchContent({
        details: [{ title: "探索问题", bullets: ["- 要点"] }],
        steps: [],
      })
    ).toBe(true)
    expect(
      hasDeepSearchContent({
        details: [],
        steps: [{ tags: ["header"], title: "Step", text: ["A"] }],
      })
    ).toBe(true)
  })
})

describe("multi-agent rollout merge", () => {
  it("merges rollout ids from research uiLayout for agent detection", () => {
    const merged = mergeReasoningRolloutIds(
      ["Grok"],
      {
        uiLayout: {
          rolloutIds: ["Chat Room Planner", "Chat Room Critic"],
        },
      }
    )

    expect(merged).toEqual(["Grok", "Planner", "Critic"])
    const agents = collectRolloutAgents(merged)
    expect(agents.length).toBe(3)
  })

  it("allows timeline only when there is no multi-agent rollout", () => {
    const merged = mergeReasoningRolloutIds(
      ["Grok"],
      {
        uiLayout: {
          rolloutIds: ["Grok"],
        },
      }
    )
    const agents = collectRolloutAgents(merged)
    const useResearchTimelineView =
      hasDeepSearchContent({
        details: [{ title: "探索问题", bullets: ["- 要点"] }],
        steps: [],
      }) && agents.length <= 1

    expect(useResearchTimelineView).toBe(true)
  })
})
