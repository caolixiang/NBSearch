export type PendingRecoveryNoneRetryTracker = Record<
  string,
  {
    messageId: string
    remaining: number
  }
>

function normalizeRetryBudget(maxRetries: number): number {
  if (!Number.isFinite(maxRetries)) {
    return 0
  }
  return Math.max(0, Math.trunc(maxRetries))
}

export function shouldContinuePendingRecoveryAfterNoneResult(
  tracker: PendingRecoveryNoneRetryTracker,
  conversationId: string,
  messageId: string,
  maxRetries: number
): boolean {
  const normalizedConversationId = conversationId.trim()
  const normalizedMessageId = messageId.trim()
  if (!normalizedConversationId || !normalizedMessageId) {
    return false
  }

  const budget = normalizeRetryBudget(maxRetries)
  const current = tracker[normalizedConversationId]
  if (!current || current.messageId !== normalizedMessageId) {
    tracker[normalizedConversationId] = {
      messageId: normalizedMessageId,
      remaining: budget,
    }
  }

  const entry = tracker[normalizedConversationId]
  if (!entry || entry.remaining <= 0) {
    return false
  }

  entry.remaining -= 1
  return true
}

export function clearPendingRecoveryNoneRetryBudget(
  tracker: PendingRecoveryNoneRetryTracker,
  conversationId: string
): void {
  const normalizedConversationId = conversationId.trim()
  if (!normalizedConversationId) {
    return
  }
  delete tracker[normalizedConversationId]
}

