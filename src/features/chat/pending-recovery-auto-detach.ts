export type PendingAutoDetachState = {
  messageId: string
  attempts: number
  lastAttemptAt: number
}

export function resolvePendingAutoDetachDecision(input: {
  pendingMessageId: string
  now: number
  pendingAgeMs: number
  thresholdMs: number
  retryIntervalMs: number
  maxAttempts: number
  state?: PendingAutoDetachState
}): {
  shouldTrigger: boolean
  nextState?: PendingAutoDetachState
} {
  const currentState =
    input.state && input.state.messageId === input.pendingMessageId
      ? input.state
      : {
          messageId: input.pendingMessageId,
          attempts: 0,
          lastAttemptAt: 0,
        }
  if (input.pendingAgeMs < input.thresholdMs) {
    return {
      shouldTrigger: false,
      nextState: currentState,
    }
  }
  if (currentState.attempts >= input.maxAttempts) {
    return {
      shouldTrigger: false,
      nextState: currentState,
    }
  }
  if (currentState.lastAttemptAt > 0 && input.now - currentState.lastAttemptAt < input.retryIntervalMs) {
    return {
      shouldTrigger: false,
      nextState: currentState,
    }
  }
  return {
    shouldTrigger: true,
    nextState: {
      messageId: input.pendingMessageId,
      attempts: currentState.attempts + 1,
      lastAttemptAt: input.now,
    },
  }
}
