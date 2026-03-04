import { describe, expect, it } from "bun:test"
import type { ChatDeepSearchResearchStep, ChatReasoningEventDetail } from "@/domain/chat/types"
import { buildDeepSearchGroupedSections, buildStructuredReasoningSummary } from "./structured-reasoning"

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
})
