import type { ChatReasoningEventDetail } from "@/domain/chat/types"

export type ConversationStreamingState = {
  assistantText: string
  reasoningEvents: ChatReasoningEventDetail[]
  reasoningActive: boolean
  reasoningDurationSeconds: number
  startedAt: number
  lastHeartbeatAt?: number
  leadAnchorMessageId: string | null
}

export type ConversationStreamingStateMap = Record<string, ConversationStreamingState>

export function getConversationStreamingState(
  map: ConversationStreamingStateMap,
  conversationId?: string | null
): ConversationStreamingState | undefined {
  if (!conversationId) {
    return undefined
  }
  return map[conversationId]
}

export function isConversationStreaming(
  map: ConversationStreamingStateMap,
  conversationId?: string | null
): boolean {
  if (!conversationId) {
    return false
  }
  return Boolean(map[conversationId])
}

export function upsertConversationStreamingState(
  map: ConversationStreamingStateMap,
  conversationId: string,
  state: ConversationStreamingState
): ConversationStreamingStateMap {
  return {
    ...map,
    [conversationId]: state,
  }
}

export function patchConversationStreamingState(
  map: ConversationStreamingStateMap,
  conversationId: string,
  patch: Partial<ConversationStreamingState>
): ConversationStreamingStateMap {
  const current = map[conversationId]
  if (!current) {
    return map
  }
  return {
    ...map,
    [conversationId]: {
      ...current,
      ...patch,
    },
  }
}

export function removeConversationStreamingState(
  map: ConversationStreamingStateMap,
  conversationId: string
): ConversationStreamingStateMap {
  if (!(conversationId in map)) {
    return map
  }
  const next = { ...map }
  delete next[conversationId]
  return next
}
