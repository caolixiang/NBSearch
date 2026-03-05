import { describe, expect, it } from "bun:test"
import { resolvePendingAutoDetachDecision } from "./pending-recovery-auto-detach"

describe("resolvePendingAutoDetachDecision", () => {
  const base = {
    pendingMessageId: "msg_1",
    now: 20_000,
    pendingAgeMs: 20_000,
    thresholdMs: 18_000,
    retryIntervalMs: 15_000,
    maxAttempts: 3,
  }

  it("triggers the first auto detached retry after threshold", () => {
    const result = resolvePendingAutoDetachDecision(base)
    expect(result.shouldTrigger).toBe(true)
    expect(result.nextState).toEqual({
      messageId: "msg_1",
      attempts: 1,
      lastAttemptAt: 20_000,
    })
  })

  it("does not trigger before threshold", () => {
    const result = resolvePendingAutoDetachDecision({
      ...base,
      pendingAgeMs: 17_000,
    })
    expect(result.shouldTrigger).toBe(false)
    expect(result.nextState?.attempts).toBe(0)
  })

  it("does not trigger again during cooldown window", () => {
    const result = resolvePendingAutoDetachDecision({
      ...base,
      state: {
        messageId: "msg_1",
        attempts: 1,
        lastAttemptAt: 12_000,
      },
    })
    expect(result.shouldTrigger).toBe(false)
    expect(result.nextState).toEqual({
      messageId: "msg_1",
      attempts: 1,
      lastAttemptAt: 12_000,
    })
  })

  it("triggers again after cooldown window", () => {
    const result = resolvePendingAutoDetachDecision({
      ...base,
      now: 30_000,
      state: {
        messageId: "msg_1",
        attempts: 1,
        lastAttemptAt: 12_000,
      },
    })
    expect(result.shouldTrigger).toBe(true)
    expect(result.nextState).toEqual({
      messageId: "msg_1",
      attempts: 2,
      lastAttemptAt: 30_000,
    })
  })

  it("resets attempts when pending message changes", () => {
    const result = resolvePendingAutoDetachDecision({
      ...base,
      pendingMessageId: "msg_2",
      state: {
        messageId: "msg_1",
        attempts: 3,
        lastAttemptAt: 2_000,
      },
    })
    expect(result.shouldTrigger).toBe(true)
    expect(result.nextState).toEqual({
      messageId: "msg_2",
      attempts: 1,
      lastAttemptAt: 20_000,
    })
  })

  it("respects max attempt cap", () => {
    const result = resolvePendingAutoDetachDecision({
      ...base,
      state: {
        messageId: "msg_1",
        attempts: 3,
        lastAttemptAt: 1_000,
      },
    })
    expect(result.shouldTrigger).toBe(false)
    expect(result.nextState).toEqual({
      messageId: "msg_1",
      attempts: 3,
      lastAttemptAt: 1_000,
    })
  })
})
