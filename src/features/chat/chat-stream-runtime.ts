import type { ChatMessage, ChatReasoningEventDetail } from "@/domain/chat/types"
import type { ConversationStreamingState } from "./conversation-streaming-state"

export function hasAnyThinkTag(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.includes("<think") || lower.includes("</think>")
}

export function hasOpenThinkTag(value: string): boolean {
  const lower = value.toLowerCase()
  const openIndex = lower.lastIndexOf("<think")
  if (openIndex < 0) {
    return false
  }
  const closeIndex = lower.lastIndexOf("</think>")
  return openIndex > closeIndex
}

export function inferReasoningActive(events: ChatReasoningEventDetail[]): boolean {
  const runningToolUsageCardIds = new Set<string>()
  let explicitState: boolean | undefined

  for (const detail of events) {
    if (detail.kind === "ui_layout") {
      if (typeof detail.isThinking === "boolean") {
        explicitState = detail.isThinking
      }
      continue
    }

    if (detail.kind === "tool_usage") {
      runningToolUsageCardIds.add(detail.usage.toolUsageCardId)
      if (typeof detail.usage.isThinking === "boolean") {
        explicitState = detail.usage.isThinking
      }
      continue
    }

    if (detail.kind === "tool_result") {
      if (detail.result.toolUsageCardId) {
        runningToolUsageCardIds.delete(detail.result.toolUsageCardId)
      }
      if (typeof detail.result.isThinking === "boolean") {
        explicitState = detail.result.isThinking
      }
    }
  }

  if (explicitState === false) {
    return false
  }

  if (runningToolUsageCardIds.size > 0) {
    return true
  }

  return explicitState === true
}

export function resolveReasoningDurationSeconds(
  reasoningStartedAtMs: number | null,
  reasoningEndedAtMs: number | null,
  nowMs: number = Date.now()
): number {
  if (!reasoningStartedAtMs || reasoningStartedAtMs <= 0) {
    return 0
  }
  const endMs =
    reasoningEndedAtMs && reasoningEndedAtMs > reasoningStartedAtMs
      ? reasoningEndedAtMs
      : nowMs
  if (endMs <= reasoningStartedAtMs) {
    return 0
  }
  return Math.max(1, Math.round((endMs - reasoningStartedAtMs) / 1000))
}

export function appendReasoningEvent(
  previous: ChatReasoningEventDetail[],
  detail: ChatReasoningEventDetail
): ChatReasoningEventDetail[] {
  if (detail.kind === "ui_layout") {
    const previousLayout = previous.find(
      (item): item is Extract<ChatReasoningEventDetail, { kind: "ui_layout" }> => item.kind === "ui_layout"
    )
    const mergedLayout =
      previousLayout &&
      previousLayout.layout.rolloutIds.length > 0 &&
      detail.layout.rolloutIds.length === 0
        ? {
            ...detail,
            layout: {
              reasoningUiLayout: detail.layout.reasoningUiLayout ?? previousLayout.layout.reasoningUiLayout,
              willThinkLong: detail.layout.willThinkLong ?? previousLayout.layout.willThinkLong,
              effort: detail.layout.effort ?? previousLayout.layout.effort,
              rolloutIds: previousLayout.layout.rolloutIds,
            },
          }
        : detail
    const filtered = previous.filter((item) => item.kind !== "ui_layout")
    return [...filtered, mergedLayout]
  }

  if (detail.kind === "tool_usage") {
    const index = previous.findIndex(
      (item) => item.kind === "tool_usage" && item.usage.toolUsageCardId === detail.usage.toolUsageCardId
    )
    if (index < 0) {
      return [...previous, detail]
    }
    const next = previous.slice()
    next[index] = detail
    return next
  }

  if (detail.kind === "tool_result") {
    const key = detail.result.toolUsageCardId || ""
    if (!key) {
      return [...previous, detail]
    }
    const index = previous.findIndex(
      (item) => item.kind === "tool_result" && item.result.toolUsageCardId === key
    )
    if (index < 0) {
      return [...previous, detail]
    }
    const next = previous.slice()
    next[index] = detail
    return next
  }

  const index = previous.findIndex(
    (item) => item.kind === "card_attachment" && item.card.id === detail.card.id
  )
  if (index < 0) {
    return [...previous, detail]
  }
  const next = previous.slice()
  next[index] = detail
  return next
}

export type ChatStreamScheduler = {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (callback: () => void, delayMs: number) => unknown
  clearInterval: (handle: unknown) => void
}

const defaultScheduler: ChatStreamScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
}

export type ChatStreamFinalizeResult = {
  reasoningSnapshot: ChatReasoningEventDetail[]
  finalDurationSeconds: number
  shouldPersistReasoningDuration: boolean
}

export type CreateChatStreamRuntimeInput = {
  leadAnchorMessageId: string | null
  setStreamingState: (state: ConversationStreamingState) => void
  patchStreamingState: (patch: Partial<ConversationStreamingState>) => void
  clearStreamingState: () => void
  scheduler?: ChatStreamScheduler
}

export type ChatStreamRuntime = {
  handleHeartbeat: (timestampMs: number) => void
  handleDelta: (textDelta: string) => void
  handleReasoning: (detail: ChatReasoningEventDetail) => void
  finalize: (assistantMessage: ChatMessage) => ChatStreamFinalizeResult
  clear: () => void
}

export function createChatStreamRuntime(input: CreateChatStreamRuntimeInput): ChatStreamRuntime {
  const scheduler = input.scheduler || defaultScheduler
  const startedAt = scheduler.now()

  let assistantText = ""
  let reasoningEvents: ChatReasoningEventDetail[] = []
  let reasoningActive = false
  let assistantOutputStarted = false
  let reasoningEverStarted = false
  let reasoningStartedAtMs: number | null = null
  let reasoningEndedAtMs: number | null = null
  let reasoningStopTimer: unknown = null
  let pendingCardAttachmentDetails: ChatReasoningEventDetail[] = []
  let cardAttachmentFlushTimer: unknown = null
  let cleared = false

  input.setStreamingState({
    assistantText: "",
    reasoningEvents: [],
    reasoningActive: false,
    reasoningDurationSeconds: 0,
    startedAt,
    lastHeartbeatAt: startedAt,
    leadAnchorMessageId: input.leadAnchorMessageId,
  })

  const syncStreamingState = () => {
    input.patchStreamingState({
      assistantText,
      reasoningEvents,
      reasoningActive,
    })
  }

  const clearReasoningStopTimer = () => {
    if (reasoningStopTimer !== null) {
      scheduler.clearTimeout(reasoningStopTimer)
      reasoningStopTimer = null
    }
  }

  const clearCardAttachmentFlushTimer = () => {
    if (cardAttachmentFlushTimer !== null) {
      scheduler.clearTimeout(cardAttachmentFlushTimer)
      cardAttachmentFlushTimer = null
    }
  }

  const flushPendingCardAttachments = (syncAfterFlush: boolean) => {
    clearCardAttachmentFlushTimer()
    if (pendingCardAttachmentDetails.length === 0) {
      return
    }
    for (const detail of pendingCardAttachmentDetails) {
      reasoningEvents = appendReasoningEvent(reasoningEvents, detail)
    }
    pendingCardAttachmentDetails = []
    if (syncAfterFlush) {
      syncStreamingState()
    }
  }

  const scheduleCardAttachmentFlush = () => {
    if (cardAttachmentFlushTimer !== null) {
      return
    }
    cardAttachmentFlushTimer = scheduler.setTimeout(() => {
      cardAttachmentFlushTimer = null
      flushPendingCardAttachments(true)
    }, 180)
  }

  const markReasoningStarted = () => {
    const now = scheduler.now()
    if (!reasoningStartedAtMs) {
      reasoningStartedAtMs = now
    }
    reasoningEndedAtMs = null
  }

  const markReasoningEnded = () => {
    if (reasoningStartedAtMs && !reasoningEndedAtMs) {
      reasoningEndedAtMs = scheduler.now()
    }
  }

  const durationTimer = scheduler.setInterval(() => {
    const nextDuration = resolveReasoningDurationSeconds(
      reasoningStartedAtMs,
      reasoningEndedAtMs,
      scheduler.now()
    )
    input.patchStreamingState({
      reasoningDurationSeconds: nextDuration,
    })
  }, 1000)

  const clear = () => {
    clearReasoningStopTimer()
    clearCardAttachmentFlushTimer()
    pendingCardAttachmentDetails = []
    scheduler.clearInterval(durationTimer)
    if (!cleared) {
      cleared = true
      input.clearStreamingState()
    }
  }

  return {
    handleHeartbeat(timestampMs) {
      input.patchStreamingState({
        lastHeartbeatAt: timestampMs,
      })
    },
    handleDelta(textDelta) {
      const nextText = `${assistantText}${textDelta}`
      assistantText = nextText
      const hasVisibleDelta = textDelta.trim().length > 0
      if (hasVisibleDelta) {
        assistantOutputStarted = true
      }

      if (
        assistantOutputStarted &&
        (reasoningEverStarted || reasoningEvents.length > 0 || reasoningActive) &&
        (!hasAnyThinkTag(nextText) || !hasOpenThinkTag(nextText))
      ) {
        clearReasoningStopTimer()
        reasoningActive = false
        markReasoningEnded()
      }
      syncStreamingState()
    },
    handleReasoning(detail) {
      if (detail.kind === "card_attachment") {
        pendingCardAttachmentDetails.push(detail)
        scheduleCardAttachmentFlush()
        return
      }

      flushPendingCardAttachments(false)
      reasoningEvents = appendReasoningEvent(reasoningEvents, detail)
      const nextReasoningActive = inferReasoningActive(reasoningEvents)
      if (nextReasoningActive && !assistantOutputStarted) {
        reasoningEverStarted = true
        clearReasoningStopTimer()
        reasoningActive = true
        markReasoningStarted()
      } else if (assistantOutputStarted) {
        clearReasoningStopTimer()
        reasoningActive = false
        markReasoningEnded()
      } else if (reasoningEverStarted && !assistantText.trim()) {
        clearReasoningStopTimer()
        reasoningActive = true
        markReasoningStarted()
      } else if (reasoningStopTimer === null) {
        reasoningStopTimer = scheduler.setTimeout(() => {
          reasoningActive = false
          reasoningStopTimer = null
          markReasoningEnded()
          syncStreamingState()
        }, 700)
      }
      syncStreamingState()
    },
    finalize(assistantMessage) {
      flushPendingCardAttachments(false)
      clearReasoningStopTimer()
      markReasoningEnded()
      const reasoningSnapshot = assistantMessage.reasoningEvents || reasoningEvents
      const computedDurationSeconds = resolveReasoningDurationSeconds(
        reasoningStartedAtMs,
        reasoningEndedAtMs,
        scheduler.now()
      )
      const upstreamDurationSeconds =
        typeof assistantMessage.reasoningDurationSeconds === "number" &&
        assistantMessage.reasoningDurationSeconds > 0
          ? Math.max(1, Math.round(assistantMessage.reasoningDurationSeconds))
          : 0
      const finalDurationSeconds = computedDurationSeconds || upstreamDurationSeconds
      const shouldPersistReasoningDuration =
        finalDurationSeconds > 0 || reasoningEverStarted || reasoningSnapshot.length > 0
      clear()
      return {
        reasoningSnapshot,
        finalDurationSeconds,
        shouldPersistReasoningDuration,
      }
    },
    clear,
  }
}

export type PersistCompletedReasoningInput = {
  conversationId: string
  assistantMessage: ChatMessage
  reasoningSnapshot: ChatReasoningEventDetail[]
  finalDurationSeconds: number
  shouldPersistReasoningDuration: boolean
  upsertPersistedReasoningEntry: (
    conversationId: string,
    messageId: string,
    responseId: string,
    events: ChatReasoningEventDetail[]
  ) => void
  upsertPersistedReasoningDurationEntry: (
    conversationId: string,
    messageId: string,
    responseId: string,
    duration: number
  ) => void
}

export function persistCompletedReasoning(input: PersistCompletedReasoningInput): void {
  const messageId = input.assistantMessage.id.trim()
  const responseId = input.assistantMessage.responseId?.trim() || ""
  const normalizedDuration = Math.max(1, input.finalDurationSeconds || 1)

  if (input.reasoningSnapshot.length > 0) {
    input.upsertPersistedReasoningEntry(
      input.conversationId,
      messageId,
      responseId,
      input.reasoningSnapshot
    )
    if (input.shouldPersistReasoningDuration) {
      input.upsertPersistedReasoningDurationEntry(
        input.conversationId,
        messageId,
        responseId,
        normalizedDuration
      )
    }
    return
  }

  if (input.shouldPersistReasoningDuration) {
    input.upsertPersistedReasoningDurationEntry(
      input.conversationId,
      messageId,
      responseId,
      normalizedDuration
    )
  }
}
