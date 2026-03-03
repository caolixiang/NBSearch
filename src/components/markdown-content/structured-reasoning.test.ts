import { describe, expect, it } from "bun:test"
import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import { buildStructuredReasoningSummary } from "./structured-reasoning"

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
