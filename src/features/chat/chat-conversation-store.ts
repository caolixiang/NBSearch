import { create } from "zustand"
import type { ChatMessage as DomainChatMessage, ChatReasoningEventDetail } from "@/domain/chat/types"
import type { ConversationStreamingState } from "./conversation-streaming-state"

type ReasoningByMessageId = Record<string, ChatReasoningEventDetail[]>
type ReasoningDurationByMessageId = Record<string, number>

type ChatConversationState = {
  hasDraftConversation: boolean
  draftConversationUpdatedAt: number
  activeConversationId: string | null
  messagesByConversationId: Record<string, DomainChatMessage[]>
  streamingStateByConversationId: Record<string, ConversationStreamingState>
  persistedReasoningByConversationId: Record<string, ReasoningByMessageId>
  persistedReasoningDurationByConversationId: Record<string, ReasoningDurationByMessageId>
  lastErrorByConversationId: Record<string, string>
}

type ChatConversationActions = {
  setHasDraftConversation: (next: boolean) => void
  setDraftConversationUpdatedAt: (next: number) => void
  setActiveConversationId: (next: string | null) => void
  setMessagesForConversation: (conversationId: string, messages: DomainChatMessage[]) => void
  appendMessageForConversation: (conversationId: string, message: DomainChatMessage) => void
  clearMessagesForConversation: (conversationId: string) => void
  removeConversationCaches: (conversationId: string) => void
  setStreamingStateForConversation: (conversationId: string, next: ConversationStreamingState) => void
  patchStreamingStateForConversation: (
    conversationId: string,
    patch: Partial<ConversationStreamingState>
  ) => void
  removeStreamingStateForConversation: (conversationId: string) => void
  setPersistedReasoningForConversation: (conversationId: string, next: ReasoningByMessageId) => void
  upsertPersistedReasoningEntry: (
    conversationId: string,
    messageId: string,
    responseId: string,
    events: ChatReasoningEventDetail[]
  ) => void
  setPersistedReasoningDurationForConversation: (
    conversationId: string,
    next: ReasoningDurationByMessageId
  ) => void
  upsertPersistedReasoningDurationEntry: (
    conversationId: string,
    messageId: string,
    responseId: string,
    duration: number
  ) => void
  setLastErrorForConversation: (conversationId: string, message: string) => void
  clearLastErrorForConversation: (conversationId: string) => void
}

export type ChatConversationStore = ChatConversationState & ChatConversationActions

export const useChatConversationStore = create<ChatConversationStore>((set) => ({
  hasDraftConversation: false,
  draftConversationUpdatedAt: 0,
  activeConversationId: null,
  messagesByConversationId: {},
  streamingStateByConversationId: {},
  persistedReasoningByConversationId: {},
  persistedReasoningDurationByConversationId: {},
  lastErrorByConversationId: {},

  setHasDraftConversation: (next) => set({ hasDraftConversation: next }),
  setDraftConversationUpdatedAt: (next) => set({ draftConversationUpdatedAt: next }),
  setActiveConversationId: (next) => set({ activeConversationId: next }),

  setMessagesForConversation: (conversationId, messages) =>
    set((state) => ({
      messagesByConversationId: {
        ...state.messagesByConversationId,
        [conversationId]: messages,
      },
    })),

  appendMessageForConversation: (conversationId, message) =>
    set((state) => ({
      messagesByConversationId: {
        ...state.messagesByConversationId,
        [conversationId]: [...(state.messagesByConversationId[conversationId] || []), message],
      },
    })),

  clearMessagesForConversation: (conversationId) =>
    set((state) => ({
      messagesByConversationId: {
        ...state.messagesByConversationId,
        [conversationId]: [],
      },
    })),

  removeConversationCaches: (conversationId) =>
    set((state) => {
      const nextMessages = { ...state.messagesByConversationId }
      const nextStreaming = { ...state.streamingStateByConversationId }
      const nextReasoning = { ...state.persistedReasoningByConversationId }
      const nextReasoningDuration = { ...state.persistedReasoningDurationByConversationId }
      const nextErrors = { ...state.lastErrorByConversationId }

      delete nextMessages[conversationId]
      delete nextStreaming[conversationId]
      delete nextReasoning[conversationId]
      delete nextReasoningDuration[conversationId]
      delete nextErrors[conversationId]

      return {
        messagesByConversationId: nextMessages,
        streamingStateByConversationId: nextStreaming,
        persistedReasoningByConversationId: nextReasoning,
        persistedReasoningDurationByConversationId: nextReasoningDuration,
        lastErrorByConversationId: nextErrors,
      }
    }),

  setStreamingStateForConversation: (conversationId, next) =>
    set((state) => ({
      streamingStateByConversationId: {
        ...state.streamingStateByConversationId,
        [conversationId]: next,
      },
    })),

  patchStreamingStateForConversation: (conversationId, patch) =>
    set((state) => {
      const current = state.streamingStateByConversationId[conversationId]
      if (!current) {
        return state
      }
      return {
        streamingStateByConversationId: {
          ...state.streamingStateByConversationId,
          [conversationId]: {
            ...current,
            ...patch,
          },
        },
      }
    }),

  removeStreamingStateForConversation: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.streamingStateByConversationId)) {
        return state
      }
      const next = { ...state.streamingStateByConversationId }
      delete next[conversationId]
      return {
        streamingStateByConversationId: next,
      }
    }),

  setPersistedReasoningForConversation: (conversationId, next) =>
    set((state) => ({
      persistedReasoningByConversationId: {
        ...state.persistedReasoningByConversationId,
        [conversationId]: next,
      },
    })),

  upsertPersistedReasoningEntry: (conversationId, messageId, responseId, events) =>
    set((state) => ({
      persistedReasoningByConversationId: {
        ...state.persistedReasoningByConversationId,
        [conversationId]: {
          ...(state.persistedReasoningByConversationId[conversationId] || {}),
          [messageId]: events,
          ...(responseId ? { [responseId]: events } : {}),
        },
      },
    })),

  setPersistedReasoningDurationForConversation: (conversationId, next) =>
    set((state) => ({
      persistedReasoningDurationByConversationId: {
        ...state.persistedReasoningDurationByConversationId,
        [conversationId]: next,
      },
    })),

  upsertPersistedReasoningDurationEntry: (conversationId, messageId, responseId, duration) =>
    set((state) => ({
      persistedReasoningDurationByConversationId: {
        ...state.persistedReasoningDurationByConversationId,
        [conversationId]: {
          ...(state.persistedReasoningDurationByConversationId[conversationId] || {}),
          [messageId]: duration,
          ...(responseId ? { [responseId]: duration } : {}),
        },
      },
    })),

  setLastErrorForConversation: (conversationId, message) =>
    set((state) => ({
      lastErrorByConversationId: {
        ...state.lastErrorByConversationId,
        [conversationId]: message,
      },
    })),

  clearLastErrorForConversation: (conversationId) =>
    set((state) => ({
      lastErrorByConversationId: {
        ...state.lastErrorByConversationId,
        [conversationId]: "",
      },
    })),
}))
