import { describe, expect, it } from "bun:test"
import {
  clearPendingRecoveryNoneRetryBudget,
  shouldContinuePendingRecoveryAfterNoneResult,
  type PendingRecoveryNoneRetryTracker,
} from "./pending-recovery-bootstrap"

describe("pending-recovery-bootstrap", () => {
  it("consumes retry budget and then stops", () => {
    const tracker: PendingRecoveryNoneRetryTracker = {}
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 2)).toBe(true)
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 2)).toBe(true)
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 2)).toBe(false)
  })

  it("resets budget when pending message id changes", () => {
    const tracker: PendingRecoveryNoneRetryTracker = {}
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 1)).toBe(true)
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 1)).toBe(false)
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_2", 1)).toBe(true)
  })

  it("supports clearing budget by conversation", () => {
    const tracker: PendingRecoveryNoneRetryTracker = {}
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 1)).toBe(true)
    clearPendingRecoveryNoneRetryBudget(tracker, "conv_1")
    expect(shouldContinuePendingRecoveryAfterNoneResult(tracker, "conv_1", "msg_1", 1)).toBe(true)
  })
})
