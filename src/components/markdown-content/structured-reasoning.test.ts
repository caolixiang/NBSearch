import { describe, expect, it } from "bun:test"
import type { ChatDeepSearchResearchStep, ChatReasoningEventDetail } from "@/domain/chat/types"
import { buildDeepSearchGroupedSections, buildDeepSearchTimeline, buildStructuredReasoningSummary } from "./structured-reasoning"

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
