import { describe, expect, it } from "bun:test"
import type { ChatMessage, ChatReasoningEventDetail } from "@/domain/chat/types"
import type { ConversationStreamingState } from "./conversation-streaming-state"
import {
  appendReasoningEvent,
  createChatStreamRuntime,
  hasAnyThinkTag,
  hasOpenThinkTag,
  persistCompletedReasoning,
} from "./chat-stream-runtime"

class FakeScheduler {
  private currentMs = 1
  private nextId = 1
  private timers = new Map<number, { at: number; intervalMs: number | null; callback: () => void }>()

  now = (): number => this.currentMs

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId += 1
    this.timers.set(id, {
      at: this.currentMs + delayMs,
      intervalMs: null,
      callback,
    })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  setInterval = (callback: () => void, delayMs: number): number => {
    const id = this.nextId += 1
    this.timers.set(id, {
      at: this.currentMs + delayMs,
      intervalMs: delayMs,
      callback,
    })
    return id
  }

  clearInterval = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  advanceBy(delayMs: number): void {
    const target = this.currentMs + delayMs
    while (true) {
      let nextId: number | null = null
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers.entries()) {
        if (timer.at < nextAt) {
          nextAt = timer.at
          nextId = id
        }
      }
      if (nextId === null || nextAt > target) {
        break
      }
      this.currentMs = nextAt
      const current = this.timers.get(nextId)
      if (!current) {
        continue
      }
      if (current.intervalMs === null) {
        this.timers.delete(nextId)
      } else {
        current.at = this.currentMs + current.intervalMs
        this.timers.set(nextId, current)
      }
      current.callback()
    }
    this.currentMs = target
  }
}

describe("chat-stream-runtime helpers", () => {
  it("detects think markup boundaries", () => {
    expect(hasAnyThinkTag("<think>foo")).toBe(true)
    expect(hasAnyThinkTag("plain text")).toBe(false)
    expect(hasOpenThinkTag("<think>foo")).toBe(true)
    expect(hasOpenThinkTag("<think>foo</think>bar")).toBe(false)
  })

  it("merges repeated reasoning events by semantic key", () => {
    const firstLayout: ChatReasoningEventDetail = {
      kind: "ui_layout",
      layout: {
        rolloutIds: ["rollout-1"],
      },
      isThinking: true,
    }
    const secondLayout: ChatReasoningEventDetail = {
      kind: "ui_layout",
      layout: {
        reasoningUiLayout: "SPLIT",
        rolloutIds: [],
      },
    }
    const firstCard: ChatReasoningEventDetail = {
      kind: "card_attachment",
      card: {
        id: "card-1",
      },
    }
    const secondCard: ChatReasoningEventDetail = {
      kind: "card_attachment",
      card: {
        id: "card-1",
        url: "https://example.com",
      },
    }

    const mergedLayout = appendReasoningEvent([firstLayout], secondLayout)
    expect(mergedLayout).toHaveLength(1)
    expect(mergedLayout[0]?.kind).toBe("ui_layout")
    if (mergedLayout[0]?.kind === "ui_layout") {
      expect(mergedLayout[0].layout.reasoningUiLayout).toBe("SPLIT")
      expect(mergedLayout[0].layout.rolloutIds).toEqual(["rollout-1"])
    }

    const mergedCards = appendReasoningEvent([firstCard], secondCard)
    expect(mergedCards).toEqual([secondCard])
  })
})

describe("createChatStreamRuntime", () => {
  it("tracks reasoning, delayed card flush, duration ticks, and finalize cleanup", () => {
    const scheduler = new FakeScheduler()
    const initialStates: ConversationStreamingState[] = []
    const patches: Array<Partial<ConversationStreamingState>> = []
    let clearedCount = 0

    const runtime = createChatStreamRuntime({
      leadAnchorMessageId: "lead-user",
      setStreamingState: (state) => {
        initialStates.push(state)
      },
      patchStreamingState: (patch) => {
        patches.push(patch)
      },
      clearStreamingState: () => {
        clearedCount += 1
      },
      scheduler,
    })

    expect(initialStates).toHaveLength(1)
    expect(initialStates[0]).toEqual({
      assistantText: "",
      reasoningEvents: [],
      reasoningActive: false,
      reasoningDurationSeconds: 0,
      startedAt: 1,
      lastHeartbeatAt: 1,
      leadAnchorMessageId: "lead-user",
    })

    runtime.handleHeartbeat(12)
    expect(patches.at(-1)).toEqual({ lastHeartbeatAt: 12 })

    runtime.handleReasoning({
      kind: "ui_layout",
      layout: {
        rolloutIds: [],
      },
      isThinking: true,
    })
    expect(patches.at(-1)?.reasoningActive).toBe(true)
    expect(patches.at(-1)?.reasoningEvents).toHaveLength(1)

    scheduler.advanceBy(1000)
    expect(patches.at(-1)).toEqual({ reasoningDurationSeconds: 1 })

    runtime.handleReasoning({
      kind: "card_attachment",
      card: {
        id: "card-1",
      },
    })
    const patchCountBeforeFlush = patches.length
    scheduler.advanceBy(179)
    expect(patches).toHaveLength(patchCountBeforeFlush)
    scheduler.advanceBy(1)
    expect(patches).toHaveLength(patchCountBeforeFlush + 1)
    expect(patches.at(-1)?.reasoningEvents).toHaveLength(2)

    runtime.handleDelta("Answer")
    expect(patches.at(-1)?.assistantText).toBe("Answer")
    expect(patches.at(-1)?.reasoningActive).toBe(false)

    const completedAssistantMessage: ChatMessage = {
      id: "asst-1",
      role: "assistant",
      content: "Answer",
      createdAt: scheduler.now(),
      status: "completed",
    }
    const completion = runtime.finalize(completedAssistantMessage)
    expect(completion.reasoningSnapshot).toHaveLength(2)
    expect(completion.finalDurationSeconds).toBe(1)
    expect(completion.shouldPersistReasoningDuration).toBe(true)
    expect(clearedCount).toBe(1)

    const patchCountAfterFinalize = patches.length
    scheduler.advanceBy(1000)
    expect(patches).toHaveLength(patchCountAfterFinalize)

    runtime.clear()
    expect(clearedCount).toBe(1)
  })
})

describe("persistCompletedReasoning", () => {
  it("writes reasoning snapshot and normalized duration through callbacks", () => {
    const reasoningCalls: Array<{ messageId: string; responseId: string; events: ChatReasoningEventDetail[] }> = []
    const durationCalls: Array<{ messageId: string; responseId: string; duration: number }> = []
    const assistantMessage: ChatMessage = {
      id: "asst-2",
      role: "assistant",
      content: "done",
      createdAt: 1,
      responseId: "resp-2",
      status: "completed",
    }
    const reasoningSnapshot: ChatReasoningEventDetail[] = [
      {
        kind: "ui_layout",
        layout: {
          rolloutIds: [],
        },
      },
    ]

    persistCompletedReasoning({
      conversationId: "conv-1",
      assistantMessage,
      reasoningSnapshot,
      finalDurationSeconds: 0,
      shouldPersistReasoningDuration: true,
      upsertPersistedReasoningEntry: (_conversationId, messageId, responseId, events) => {
        reasoningCalls.push({ messageId, responseId, events })
      },
      upsertPersistedReasoningDurationEntry: (_conversationId, messageId, responseId, duration) => {
        durationCalls.push({ messageId, responseId, duration })
      },
    })

    expect(reasoningCalls).toEqual([
      {
        messageId: "asst-2",
        responseId: "resp-2",
        events: reasoningSnapshot,
      },
    ])
    expect(durationCalls).toEqual([
      {
        messageId: "asst-2",
        responseId: "resp-2",
        duration: 1,
      },
    ])
  })
})
