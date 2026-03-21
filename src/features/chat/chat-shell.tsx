import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AppFontSizeMode, AppRuntime, AppThemeMode } from "@/app/contracts"
import { applyAppearanceSettings } from "@/app/appearance"
import {
  applyAppearanceConfigToRuntime,
  applyGatewayConfigToRuntime,
  applyOpenAIConfigToRuntime,
  applyPersonalizationConfigToRuntime,
  applySubscriptionsConfigToRuntime,
} from "@/app/runtime"
import { FEED_SOURCES } from "@/domain/feed/source-config"
import type {
  ChatAnchors,
  ChatAttachment,
  ChatCardAttachmentPayload,
  ChatMessage as DomainChatMessage,
  ChatTurnAttachmentInput,
} from "@/domain/chat/types"
import type { FeedRuntimeState } from "@/domain/feed/service"
import type { FeedItemRecord, FeedPageCursor, FeedSource, FeedSubscriptionRecord } from "@/domain/feed/types"
import type { ConversationRecord } from "@/domain/storage/repository"
import { ChatInput, type ChatInputVoiceRuntimeEvent } from "@/components/chat-input"
import { ChatMessage, type RenderChatMessage, TypingIndicator } from "@/components/chat-message"
import { ChatSidebar } from "@/components/chat-sidebar"
import { ModelSelector } from "@/components/model-selector"
import { FeedPane } from "@/components/polymarket-feed-pane"
import { SettingsDialog, type SettingsDialogTabId } from "@/components/settings-dialog"
import { WelcomeScreen } from "@/components/welcome-screen"
import { cn } from "@/lib/utils"
import { buildChatAttachments } from "@/lib/chat-attachments"
import {
  getConversationStreamingState,
  isConversationStreaming,
} from "./conversation-streaming-state"
import {
  clearPendingRecoveryNoneRetryBudget,
  shouldContinuePendingRecoveryAfterNoneResult,
  type PendingRecoveryNoneRetryTracker,
} from "./pending-recovery-bootstrap"
import { useChatConversationStore } from "./chat-conversation-store"
import { resolveFastModelId, resolveThinkerModelId } from "./model-selection"
import { createChatStreamRuntime, persistCompletedReasoning } from "./chat-stream-runtime"
import {
  buildUnifiedFeedSidebarItem,
  buildAssistantRoundByMessageId,
  buildFeedResearchImageAttachments,
  buildFeedResearchMessageAttachments,
  buildFeedResearchPrompt,
  buildPdfExportMetaByMessageId,
  buildReasoningCaches,
  buildSidebarConversationItems,
  buildStreamingReasoningViewModel,
  clearStaleSessionAnchors,
  computeMessageBottomSpacerPx,
  buildVoiceConversationTitle,
  buildUserMessageContent,
  buildVisibleMessages,
  extractRetryableUserText,
  FEED_SIDEBAR_ID,
  findLatestAssistantMessageId,
  getLastPendingUserMessage,
  newConversationId,
  resolvePrimaryFeedSource,
  resolveVoiceResumeConversationId,
  resolveSendAnchors,
  shouldDeferPendingRecovery,
  shouldShowPendingRecoveryWarmup,
} from "./chat-shell-helpers"
import { useChatShellModels } from "./use-chat-shell-models"
import { useChatShellAppUpdate } from "./use-chat-shell-app-update"
import { useChatShellScroll } from "./use-chat-shell-scroll"
import { commitVoiceMessage } from "./voice-message-commit"
import {
  backfillVoiceAssistantMessageCards,
  buildVoiceAssistantMessageContent,
  buildVoiceAssistantReasoningEvents,
  mergeVoiceAssistantCards,
} from "./voice-assistant-media"
import {
  resolveVoiceAssistantDeltaTracker,
  type VoiceAssistantDeltaTracker,
} from "./voice-assistant-stream"

const DRAFT_CONVERSATION_ID = "draft_new_conversation"
const PENDING_RECOVERY_POLL_INTERVAL_MS = 2500
const PENDING_RECOVERY_NONE_RESULT_MAX_RETRIES = 24

type FeedViewState = {
  subscription: FeedSubscriptionRecord | null
  items: FeedItemRecord[]
  cursor: FeedPageCursor | null
  hasMore: boolean
  isLoading: boolean
  loadedOnce: boolean
  researchingItemId: string | null
  runtimeState: FeedRuntimeState
}

function createInitialFeedViewState(source: FeedSource, runtime: AppRuntime): FeedViewState {
  return {
    subscription: null,
    items: [],
    cursor: null,
    hasMore: false,
    isLoading: false,
    loadedOnce: false,
    researchingItemId: null,
    runtimeState: runtime.services.feeds.getRuntimeState(source),
  }
}

export function ChatShell({ runtime }: { runtime: AppRuntime }) {
  const repository = runtime.services.repository
  const chatService = runtime.services.chat
  const feedService = runtime.services.feeds

  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [activeMainView, setActiveMainView] = useState<"chat" | "feed">("chat")
  const [activeFeedSource, setActiveFeedSource] = useState<FeedSource | null>(null)
  const [feedViewBySource, setFeedViewBySource] = useState<Record<FeedSource, FeedViewState>>({
    polymarket: createInitialFeedViewState("polymarket", runtime),
    kalshi: createInitialFeedViewState("kalshi", runtime),
  })
  const {
    hasDraftConversation,
    draftConversationUpdatedAt,
    activeConversationId,
    messagesByConversationId,
    streamingStateByConversationId,
    persistedReasoningByConversationId,
    persistedReasoningDurationByConversationId,
    setHasDraftConversation,
    setDraftConversationUpdatedAt,
    setActiveConversationId,
    setMessagesForConversation,
    appendMessageForConversation,
    clearMessagesForConversation,
    removeConversationCaches,
    setStreamingStateForConversation,
    patchStreamingStateForConversation,
    removeStreamingStateForConversation,
    setPersistedReasoningForConversation,
    upsertPersistedReasoningEntry,
    setPersistedReasoningDurationForConversation,
    upsertPersistedReasoningDurationEntry,
    setLastErrorForConversation,
    clearLastErrorForConversation,
  } = useChatConversationStore()
  const {
    modelSyncNotice,
    modelOptions,
    selectedModel,
    setSelectedModel,
    isRefreshingModels,
    refreshModelOptions,
  } = useChatShellModels(runtime)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRequestedTab, setSettingsRequestedTab] = useState<SettingsDialogTabId>("gateway")
  const [pendingRecoverySyncingByConversationId, setPendingRecoverySyncingByConversationId] = useState<
    Record<string, boolean>
  >({})
  const [completedTurnHydratingByConversationId, setCompletedTurnHydratingByConversationId] = useState<
    Record<string, boolean>
  >({})
  const [pendingRecoveryPreviewByConversationId, setPendingRecoveryPreviewByConversationId] = useState<
    Record<string, string>
  >({})
  const { readyUpdateVersion, isInstallingPreparedUpdate, installReadyUpdate } = useChatShellAppUpdate()

  const openSettings = useCallback((tab: SettingsDialogTabId = "gateway") => {
    setSettingsRequestedTab(tab)
    setSettingsOpen(true)
  }, [])

  const {
    chatInputHeight,
    setChatInputHeight,
    messagesScrollRef,
    shouldAutoScrollRef,
    setProgrammaticScrollTop,
    handleMessagesScroll,
  } = useChatShellScroll(activeConversationId)

  const abortControllerByConversationIdRef = useRef<Record<string, AbortController>>({})
  const activeConversationIdRef = useRef<string | null>(null)
  const feedViewBySourceRef = useRef(feedViewBySource)
  const messagesByConversationIdRef = useRef(messagesByConversationId)
  const streamingStateByConversationIdRef = useRef(streamingStateByConversationId)
  const attemptedPendingRecoveryMessageIdByConversationRef = useRef<Record<string, string>>({})
  const autoRetriedPendingRecoveryMessageIdByConversationRef = useRef<Record<string, string>>({})
  const pendingRecoveryNoneRetryTrackerRef = useRef<PendingRecoveryNoneRetryTracker>({})
  const voiceAssistantDeltaTrackerByConversationRef = useRef<Record<string, VoiceAssistantDeltaTracker>>({})
  const voiceAssistantCardsByConversationRef = useRef<Record<string, ChatCardAttachmentPayload[]>>({})
  const voiceAssistantCardResponseIdByConversationRef = useRef<Record<string, string>>({})
  const handleSendMessageRef = useRef<
    | ((
        text: string,
        attachments?: File[],
        options?: {
          retryExistingUserMessageId?: string
          conversationId?: string
          turnAttachments?: ChatTurnAttachmentInput[]
          messageAttachments?: ChatAttachment[]
          modelId?: string
        }
      ) => Promise<void>)
    | null
  >(null)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    feedViewBySourceRef.current = feedViewBySource
  }, [feedViewBySource])

  useEffect(() => {
    messagesByConversationIdRef.current = messagesByConversationId
  }, [messagesByConversationId])

  useEffect(() => {
    streamingStateByConversationIdRef.current = streamingStateByConversationId
  }, [streamingStateByConversationId])

  const setPendingRecoverySyncingForConversation = useCallback(
    (conversationId: string, syncing: boolean) => {
      if (!conversationId) {
        return
      }
      setPendingRecoverySyncingByConversationId((previous) => {
        if (syncing) {
          if (previous[conversationId]) {
            return previous
          }
          return {
            ...previous,
            [conversationId]: true,
          }
        }
        if (!previous[conversationId]) {
          return previous
        }
        const next = { ...previous }
        delete next[conversationId]
        return next
      })
    },
    []
  )

  const setCompletedTurnHydratingForConversation = useCallback(
    (conversationId: string, hydrating: boolean) => {
      if (!conversationId) {
        return
      }
      setCompletedTurnHydratingByConversationId((previous) => {
        if (hydrating) {
          if (previous[conversationId]) {
            return previous
          }
          return {
            ...previous,
            [conversationId]: true,
          }
        }
        if (!previous[conversationId]) {
          return previous
        }
        const next = { ...previous }
        delete next[conversationId]
        return next
      })
    },
    []
  )

  const setPendingRecoveryPreviewForConversation = useCallback(
    (conversationId: string, previewContent: string) => {
      if (!conversationId) {
        return
      }
      const normalizedPreview = previewContent.trim()
      setPendingRecoveryPreviewByConversationId((previous) => {
        if (!normalizedPreview) {
          if (!previous[conversationId]) {
            return previous
          }
          const next = { ...previous }
          delete next[conversationId]
          return next
        }
        if (previous[conversationId] === normalizedPreview) {
          return previous
        }
        return {
          ...previous,
          [conversationId]: normalizedPreview,
        }
      })
    },
    []
  )

  const activeMessages = useMemo(() => {
    if (!activeConversationId) {
      return []
    }
    return messagesByConversationId[activeConversationId] || []
  }, [activeConversationId, messagesByConversationId])

  const activePersistedReasoningByMessageId = useMemo(() => {
    if (!activeConversationId) {
      return {}
    }
    return persistedReasoningByConversationId[activeConversationId] || {}
  }, [activeConversationId, persistedReasoningByConversationId])

  const activePersistedReasoningDurationByMessageId = useMemo(() => {
    if (!activeConversationId) {
      return {}
    }
    return persistedReasoningDurationByConversationId[activeConversationId] || {}
  }, [activeConversationId, persistedReasoningDurationByConversationId])

  const activePendingUserMessage = useMemo(() => {
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return null
    }
    if (
      shouldDeferPendingRecovery({
        isConversationStreaming: isConversationStreaming(streamingStateByConversationId, activeConversationId),
        isHydratingCompletedTurn: Boolean(completedTurnHydratingByConversationId[activeConversationId]),
      })
    ) {
      return null
    }
    return getLastPendingUserMessage(activeMessages)
  }, [activeConversationId, activeMessages, completedTurnHydratingByConversationId, streamingStateByConversationId])
  const isActivePendingRecoverySyncing = useMemo(() => {
    if (!activeConversationId) {
      return false
    }
    return Boolean(pendingRecoverySyncingByConversationId[activeConversationId])
  }, [activeConversationId, pendingRecoverySyncingByConversationId])
  const isActiveCompletedTurnHydrating = useMemo(() => {
    if (!activeConversationId) {
      return false
    }
    return Boolean(completedTurnHydratingByConversationId[activeConversationId])
  }, [activeConversationId, completedTurnHydratingByConversationId])
  const activePendingRecoveryPreview = useMemo(() => {
    if (!activeConversationId) {
      return ""
    }
    return pendingRecoveryPreviewByConversationId[activeConversationId] || ""
  }, [activeConversationId, pendingRecoveryPreviewByConversationId])

  const activeStreamingState = useMemo(() => {
    return getConversationStreamingState(streamingStateByConversationId, activeConversationId)
  }, [activeConversationId, streamingStateByConversationId])
  const activeConversationTitle = useMemo(() => {
    if (activeConversationId === DRAFT_CONVERSATION_ID) {
      return "新对话"
    }
    if (!activeConversationId) {
      return "新对话"
    }
    const conversation = conversations.find((item) => item.id === activeConversationId)
    const title = conversation?.title?.trim() || ""
    return title || "新对话"
  }, [activeConversationId, conversations])

  const isActiveConversationStreaming = Boolean(activeStreamingState)
  const activeLeadAnchorMessageId = activeStreamingState?.leadAnchorMessageId || null

  const sidebarConversations = useMemo(
    () =>
      buildSidebarConversationItems(
        conversations,
        hasDraftConversation,
        DRAFT_CONVERSATION_ID,
        draftConversationUpdatedAt
      ),
    [conversations, draftConversationUpdatedAt, hasDraftConversation]
  )

  const visibleMessages = useMemo(
    () =>
      buildVisibleMessages({
        activeMessages,
        persistedReasoningByMessageId: activePersistedReasoningByMessageId,
        persistedReasoningDurationByMessageId: activePersistedReasoningDurationByMessageId,
        activeStreamingState,
        activeLeadAnchorMessageId,
      }),
    [
      activeLeadAnchorMessageId,
      activeMessages,
      activePersistedReasoningByMessageId,
      activePersistedReasoningDurationByMessageId,
      activeStreamingState,
    ]
  )

  const assistantRoundByMessageId = useMemo(
    () => buildAssistantRoundByMessageId(visibleMessages),
    [visibleMessages]
  )
  const latestAssistantMessageId = useMemo(
    () => findLatestAssistantMessageId(visibleMessages),
    [visibleMessages]
  )
  const pdfExportMetaByMessageId = useMemo(
    () => buildPdfExportMetaByMessageId(activeConversationTitle, assistantRoundByMessageId),
    [activeConversationTitle, assistantRoundByMessageId]
  )
  const shouldShowHeaderNewConversationButton = conversations.length > 0

  const resetComposerForNewConversation = useCallback(() => {
    const fastModelId = resolveFastModelId(modelOptions, selectedModel)
    if (fastModelId && fastModelId !== selectedModel) {
      setSelectedModel(fastModelId)
    }
  }, [modelOptions, selectedModel, setSelectedModel])

  const {
    activeStreamingAssistantText,
    activeStreamingReasoningEvents,
    activeStreamingReasoningActive,
    activeStreamingReasoningDurationSeconds,
    effectiveStreamingReasoningActive,
    isThinkingStreaming,
    shouldShowThinkingWarmup,
  } = useMemo(
    () => buildStreamingReasoningViewModel(activeStreamingState, isActiveConversationStreaming),
    [activeStreamingState, isActiveConversationStreaming]
  )
  const shouldShowPendingRecoveryWarmupIndicator = shouldShowPendingRecoveryWarmup({
    pendingUserMessage: activePendingUserMessage,
    isConversationStreaming: isActiveConversationStreaming,
    isPendingRecoverySyncing: isActivePendingRecoverySyncing,
    isHydratingCompletedTurn: isActiveCompletedTurnHydrating,
  })
  const messageBottomSpacerPx = useMemo(
    () => computeMessageBottomSpacerPx(chatInputHeight, isThinkingStreaming),
    [chatInputHeight, isThinkingStreaming]
  )


  const handleGatewayConfigChange = useCallback(
    (next: { apiBaseUrl: string; apiKey: string }) => {
      applyGatewayConfigToRuntime(next)
      void refreshModelOptions(true)
    },
    [refreshModelOptions]
  )

  const handleAppearanceConfigChange = useCallback(
    (next: { themeMode: AppThemeMode; fontSizeMode: AppFontSizeMode }) => {
      applyAppearanceConfigToRuntime(next)
      applyAppearanceSettings(next)
    },
    []
  )

  const handleOpenAIConfigChange = useCallback(
    (next: {
      openaiApiBaseUrl: string
      openaiApiKey: string
      openaiTranslationModel: string
    }) => {
      applyOpenAIConfigToRuntime(next)
    },
    []
  )

  const handlePersonalizationConfigChange = useCallback((next: { timezone: string }) => {
    applyPersonalizationConfigToRuntime(next)
  }, [])

  const updateFeedView = useCallback(
    (source: FeedSource, updater: (current: FeedViewState) => FeedViewState) => {
      setFeedViewBySource((previous) => ({
        ...previous,
        [source]: updater(previous[source]),
      }))
    },
    []
  )

  const loadFeedSubscription = useCallback(
    async (source: FeedSource): Promise<FeedSubscriptionRecord> => {
      const subscription = await feedService.getSubscription(source)
      updateFeedView(source, (current) => ({
        ...current,
        subscription,
      }))
      return subscription
    },
    [feedService, updateFeedView]
  )

  const loadFeedItems = useCallback(
    async (
      source: FeedSource,
      input: { append?: boolean; cursor?: FeedPageCursor | null } = {}
    ): Promise<void> => {
      updateFeedView(source, (current) => ({
        ...current,
        isLoading: true,
      }))
      try {
        const page = await feedService.listItems({
          source,
          limit: 20,
          cursor: input.append ? input.cursor ?? feedViewBySourceRef.current[source].cursor : null,
        })
        updateFeedView(source, (current) => ({
          ...current,
          items: input.append ? [...current.items, ...page.items] : page.items,
          cursor: page.nextCursor,
          hasMore: Boolean(page.nextCursor),
          loadedOnce: true,
        }))
      } finally {
        updateFeedView(source, (current) => ({
          ...current,
          isLoading: false,
        }))
      }
    },
    [feedService, updateFeedView]
  )

  const handleSubscriptionsConfigChange = useCallback(
    (next: {
      polymarketSubscriptionEnabled: boolean
      kalshiSubscriptionEnabled: boolean
    }) => {
      applySubscriptionsConfigToRuntime(next)
      for (const source of FEED_SOURCES) {
        void loadFeedSubscription(source)
      }

      const enabledBySource: Record<FeedSource, boolean> = {
        polymarket: next.polymarketSubscriptionEnabled,
        kalshi: next.kalshiSubscriptionEnabled,
      }

      for (const source of FEED_SOURCES) {
        if (!enabledBySource[source]) {
          continue
        }
        void feedService
          .syncNow(source)
          .then(() => loadFeedItems(source))
          .catch(() => {})
      }
    },
    [feedService, loadFeedItems, loadFeedSubscription]
  )

  const refreshConversations = useCallback(async (): Promise<ConversationRecord[]> => {
    const list = await repository.listConversations()
    setConversations(list)
    return list
  }, [repository])

  const loadMessages = useCallback(
    async (conversationId: string): Promise<void> => {
      const list = await chatService.listMessages(conversationId)
      setMessagesForConversation(conversationId, list)
      const caches = buildReasoningCaches(list)
      setPersistedReasoningForConversation(conversationId, caches.reasoningByMessageId)
      setPersistedReasoningDurationForConversation(conversationId, caches.reasoningDurationByMessageId)
    },
    [chatService, setMessagesForConversation, setPersistedReasoningDurationForConversation, setPersistedReasoningForConversation]
  )

  const refreshConversationCaches = useCallback(
    async (conversationId: string): Promise<void> => {
      await refreshConversations()
      if (activeConversationIdRef.current === conversationId) {
        await loadMessages(conversationId)
      }
    },
    [loadMessages, refreshConversations]
  )

  const hydrateCompletedTurnConversation = useCallback(
    async (conversationId: string, loadFailureMessage: string): Promise<void> => {
      setCompletedTurnHydratingForConversation(conversationId, true)
      setPendingRecoverySyncingForConversation(conversationId, false)
      setPendingRecoveryPreviewForConversation(conversationId, "")
      try {
        await refreshConversations()
        await loadMessages(conversationId)
        if (activeConversationIdRef.current === conversationId) {
          const node = messagesScrollRef.current
          if (node) {
            setProgrammaticScrollTop(node, node.scrollHeight)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : loadFailureMessage
        setLastErrorForConversation(conversationId, message)
      } finally {
        setCompletedTurnHydratingForConversation(conversationId, false)
      }
    },
    [
      loadMessages,
      refreshConversations,
      setCompletedTurnHydratingForConversation,
      setLastErrorForConversation,
      setPendingRecoveryPreviewForConversation,
      setPendingRecoverySyncingForConversation,
      setProgrammaticScrollTop,
    ]
  )

  const clearVoiceAssistantStreamingState = useCallback(
    (conversationId: string) => {
      delete voiceAssistantDeltaTrackerByConversationRef.current[conversationId]
      delete voiceAssistantCardsByConversationRef.current[conversationId]
      delete voiceAssistantCardResponseIdByConversationRef.current[conversationId]
      removeStreamingStateForConversation(conversationId)
    },
    [removeStreamingStateForConversation]
  )

  const appendVoiceAssistantCards = useCallback(
    (conversationId: string, responseId: string, cards: ChatCardAttachmentPayload[]) => {
      if (!conversationId || cards.length === 0) {
        return
      }
      const normalizedResponseId = responseId.trim()
      const previousResponseId = (voiceAssistantCardResponseIdByConversationRef.current[conversationId] || "").trim()
      const previousCards =
        normalizedResponseId && previousResponseId && previousResponseId !== normalizedResponseId
          ? []
          : voiceAssistantCardsByConversationRef.current[conversationId] || []
      voiceAssistantCardsByConversationRef.current[conversationId] = mergeVoiceAssistantCards(previousCards, cards)
      if (normalizedResponseId) {
        voiceAssistantCardResponseIdByConversationRef.current[conversationId] = normalizedResponseId
      }
    },
    []
  )

  const takeVoiceAssistantCards = useCallback((conversationId: string): ChatCardAttachmentPayload[] => {
    const cards = voiceAssistantCardsByConversationRef.current[conversationId] || []
    delete voiceAssistantCardsByConversationRef.current[conversationId]
    delete voiceAssistantCardResponseIdByConversationRef.current[conversationId]
    return cards
  }, [])

  const backfillPersistedVoiceAssistantCards = useCallback(
    async (conversationId: string, responseId: string, cards: ChatCardAttachmentPayload[]): Promise<boolean> => {
      const normalizedConversationId = conversationId.trim()
      const normalizedResponseId = responseId.trim()
      if (!normalizedConversationId || !normalizedResponseId || cards.length === 0) {
        return false
      }

      const persistedMessages = await repository.listMessages(normalizedConversationId).catch(() => [])
      const persistedAssistant = persistedMessages.find(
        (message) => message.role === "assistant" && (message.responseId || "").trim() === normalizedResponseId
      )
      if (!persistedAssistant) {
        return false
      }

      const nextMessage = backfillVoiceAssistantMessageCards(persistedAssistant, cards)
      if (!nextMessage) {
        return false
      }

      await repository.updateMessage(normalizedConversationId, nextMessage)
      return true
    },
    [repository]
  )

  const appendVoiceAssistantDelta = useCallback(
    (conversationId: string, textDelta: string) => {
      const normalizedDelta = textDelta
      if (!normalizedDelta) {
        return
      }
      const now = Date.now()
      const currentStreamingState = getConversationStreamingState(
        streamingStateByConversationIdRef.current,
        conversationId
      )
      if (!currentStreamingState) {
        setStreamingStateForConversation(conversationId, {
          assistantText: normalizedDelta,
          reasoningEvents: [],
          reasoningActive: false,
          reasoningDurationSeconds: 0,
          startedAt: now,
          lastHeartbeatAt: now,
          leadAnchorMessageId: null,
        })
      } else {
        patchStreamingStateForConversation(conversationId, {
          assistantText: `${currentStreamingState.assistantText}${normalizedDelta}`,
          lastHeartbeatAt: now,
          reasoningActive: false,
        })
      }
      shouldAutoScrollRef.current = activeConversationIdRef.current === conversationId
    },
    [patchStreamingStateForConversation, setStreamingStateForConversation]
  )

  const flushActiveVoiceAssistantStream = useCallback(
    async (conversationId: string, fallbackConversation?: ConversationRecord | null): Promise<boolean> => {
      const currentStreamingState = getConversationStreamingState(
        streamingStateByConversationIdRef.current,
        conversationId
      )
      if (!currentStreamingState) {
        return false
      }

      const currentTracker = voiceAssistantDeltaTrackerByConversationRef.current[conversationId] || null
      const assistantCards = takeVoiceAssistantCards(conversationId)
      const hasAssistantText = currentStreamingState.assistantText.trim().length > 0
      if (!hasAssistantText && assistantCards.length === 0) {
        clearVoiceAssistantStreamingState(conversationId)
        return false
      }

      const previousResponseId =
        fallbackConversation?.anchors.lastResponseId?.trim() ||
        resolveSendAnchors(
          conversationId,
          fallbackConversation || undefined,
          messagesByConversationIdRef.current[conversationId] || []
        ).lastResponseId ||
        ""

      clearVoiceAssistantStreamingState(conversationId)
      await commitVoiceMessage({
        repository,
        conversationId,
        fallbackConversation: fallbackConversation || null,
        role: "assistant",
        text: buildVoiceAssistantMessageContent(currentStreamingState.assistantText, assistantCards),
        reasoningEvents: buildVoiceAssistantReasoningEvents(assistantCards),
        sessionId: fallbackConversation?.anchors.sessionId || "",
        responseId: currentTracker?.responseId || "",
        previousResponseId,
        defaultTitle: buildVoiceConversationTitle(new Date(), runtime.config.timezone),
        messageCreatedAt: currentStreamingState.startedAt,
      })
      return true
    },
    [
      clearVoiceAssistantStreamingState,
      conversations,
      repository,
      runtime.config.timezone,
      takeVoiceAssistantCards,
    ]
  )

  const upsertConversationAnchors = useCallback(
    async (
      conversationId: string,
      patch: Partial<ChatAnchors>,
      updatedAt = Date.now()
    ): Promise<ConversationRecord> => {
      const latestConversations = await repository.listConversations()
      const fallbackConversation =
        latestConversations.find((item) => item.id === conversationId) ||
        conversations.find((item) => item.id === conversationId) ||
        null
      const nextConversation: ConversationRecord = {
        id: conversationId,
        title: fallbackConversation?.title || "",
        starred: fallbackConversation?.starred === true,
        anchors: {
          ...(fallbackConversation?.anchors || {}),
          conversationId,
          ...patch,
        },
        createdAt: fallbackConversation?.createdAt || updatedAt,
        updatedAt,
      }
      await repository.upsertConversation(nextConversation)
      return nextConversation
    },
    [conversations, repository]
  )

  const upsertVoiceSessionRecord = useCallback(
    async (
      conversationId: string,
      event: ChatInputVoiceRuntimeEvent,
      status: "issued" | "connected" | "bound" | "closed" | "failed"
    ): Promise<void> => {
      const sessionId =
        event.snapshot.voiceGatewaySessionId.trim() ||
        event.snapshot.legId.trim() ||
        `voice_${crypto.randomUUID().replaceAll("-", "")}`
      const now = Date.now()
      await repository.upsertVoiceSession({
        id: sessionId,
        conversationId,
        livekitRoom: event.snapshot.roomName || "",
        requestId: event.snapshot.requestId || "",
        status,
        startedAt: now,
        endedAt: status === "closed" || status === "failed" ? now : null,
      })
    },
    [repository]
  )

  const attemptRecoverPendingAssistant = useCallback(
    async (
      conversationId: string,
      messages: DomainChatMessage[]
    ): Promise<"recovered" | "in_progress" | "retry_send" | "none"> => {
      if (conversationId === DRAFT_CONVERSATION_ID) {
        setPendingRecoverySyncingForConversation(conversationId, false)
        setPendingRecoveryPreviewForConversation(conversationId, "")
        clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, conversationId)
        autoRetriedPendingRecoveryMessageIdByConversationRef.current[conversationId] = ""
        return "none"
      }
      const pendingUserMessage = getLastPendingUserMessage(messages)
      if (!pendingUserMessage) {
        setPendingRecoverySyncingForConversation(conversationId, false)
        setPendingRecoveryPreviewForConversation(conversationId, "")
        clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, conversationId)
        autoRetriedPendingRecoveryMessageIdByConversationRef.current[conversationId] = ""
        return "none"
      }
      const conversation = conversations.find((item) => item.id === conversationId)
      const anchors = resolveSendAnchors(conversationId, conversation, messages)
      const recovery = await chatService.recoverPendingAssistant({
        conversationId,
        anchors,
      })
      if (recovery.previewContent) {
        setPendingRecoveryPreviewForConversation(conversationId, recovery.previewContent)
      }
      if (!recovery.recovered) {
        if (recovery.retrySend) {
          const alreadyRetriedMessageId =
            autoRetriedPendingRecoveryMessageIdByConversationRef.current[conversationId] || ""
          if (alreadyRetriedMessageId === pendingUserMessage.id) {
            setPendingRecoverySyncingForConversation(conversationId, false)
            setPendingRecoveryPreviewForConversation(conversationId, "")
            return "retry_send"
          }
          const retryText = extractRetryableUserText(pendingUserMessage.content)
          if (!retryText) {
            setPendingRecoverySyncingForConversation(conversationId, false)
            setPendingRecoveryPreviewForConversation(conversationId, "")
            return "none"
          }
          autoRetriedPendingRecoveryMessageIdByConversationRef.current[conversationId] =
            pendingUserMessage.id
          setPendingRecoverySyncingForConversation(conversationId, false)
          setPendingRecoveryPreviewForConversation(conversationId, "")
          clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, conversationId)
          clearLastErrorForConversation(conversationId)
          const retryHandler = handleSendMessageRef.current
          if (!retryHandler) {
            return "none"
          }
          await retryHandler(retryText, [], {
            retryExistingUserMessageId: pendingUserMessage.id,
          })
          return "retry_send"
        }
        if (recovery.inProgress) {
          clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, conversationId)
          setPendingRecoverySyncingForConversation(conversationId, true)
          setLastErrorForConversation(conversationId, "上一轮仍在处理中，正在自动同步结果。")
          return "in_progress"
        }
        setPendingRecoverySyncingForConversation(conversationId, false)
        setPendingRecoveryPreviewForConversation(conversationId, "")
        return "none"
      }
      setPendingRecoverySyncingForConversation(conversationId, false)
      setPendingRecoveryPreviewForConversation(conversationId, "")
      clearLastErrorForConversation(conversationId)
      attemptedPendingRecoveryMessageIdByConversationRef.current[conversationId] = ""
      autoRetriedPendingRecoveryMessageIdByConversationRef.current[conversationId] = ""
      clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, conversationId)
      shouldAutoScrollRef.current = activeConversationIdRef.current === conversationId
      await refreshConversations()
      await loadMessages(conversationId)
      if (activeConversationIdRef.current === conversationId) {
        const node = messagesScrollRef.current
        if (node) {
          setProgrammaticScrollTop(node, node.scrollHeight)
        }
      }
      return "recovered"
    },
    [
      chatService,
      clearLastErrorForConversation,
      conversations,
      loadMessages,
      refreshConversations,
      setLastErrorForConversation,
      setPendingRecoveryPreviewForConversation,
      setPendingRecoverySyncingForConversation,
      setProgrammaticScrollTop,
    ]
  )

  const createConversation = useCallback(
    async (title = ""): Promise<string> => {
      const id = newConversationId()
      const now = Date.now()
      await repository.upsertConversation({
        id,
        title,
        starred: false,
        anchors: {
          conversationId: id,
        },
        createdAt: now,
        updatedAt: now,
      })
      setHasDraftConversation(false)
      setDraftConversationUpdatedAt(0)
      activeConversationIdRef.current = id
      setActiveConversationId(id)
      await refreshConversations()
      clearMessagesForConversation(id)
      return id
    },
    [clearMessagesForConversation, repository, refreshConversations, setActiveConversationId, setDraftConversationUpdatedAt, setHasDraftConversation]
  )

  const ensureConversation = useCallback(
    async (title = ""): Promise<string> => {
      if (activeConversationIdRef.current && activeConversationIdRef.current !== DRAFT_CONVERSATION_ID) {
        return activeConversationIdRef.current
      }
      return createConversation(title)
    },
    [createConversation]
  )

  const handlePrepareVoiceSession = useCallback(async (): Promise<{
    conversationId: string
    sessionId?: string
    upstreamConversationId?: string
  }> => {
    const conversationId = await ensureConversation("")
    const latestConversations = await repository.listConversations()
    const latestConversation =
      latestConversations.find((item) => item.id === conversationId) ||
      conversations.find((item) => item.id === conversationId)
    const preparedSessionId = latestConversation?.anchors.sessionId?.trim() || ""
    let sessionId = preparedSessionId || undefined
    if (preparedSessionId) {
      const availability = await chatService.inspectSessionAvailability(preparedSessionId)
      if (availability === "missing" && latestConversation) {
        await repository.upsertConversation({
          ...latestConversation,
          anchors: clearStaleSessionAnchors(latestConversation.anchors),
          updatedAt: Date.now(),
        })
        await refreshConversations()
        sessionId = undefined
      }
    }
    return {
      conversationId,
      sessionId,
      upstreamConversationId: resolveVoiceResumeConversationId(
        conversationId,
        latestConversation?.anchors
      ),
    }
  }, [chatService, conversations, ensureConversation, refreshConversations, repository, runtime.config.timezone])

  useEffect(() => {
    let mounted = true

    const initialize = async () => {
      const list = await refreshConversations()
      await Promise.all(FEED_SOURCES.map((source) => loadFeedSubscription(source)))
      if (!mounted) {
        return
      }

      if (list.length === 0) {
        return
      }

      setActiveConversationId(list[0].id)
      await loadMessages(list[0].id)
    }

    void initialize()

    return () => {
      mounted = false
      for (const controller of Object.values(abortControllerByConversationIdRef.current)) {
        controller.abort()
      }
      abortControllerByConversationIdRef.current = {}
    }
  }, [loadFeedSubscription, loadMessages, refreshConversations])

  useEffect(() => {
    const unsubscribe = feedService.subscribe((event) => {
      updateFeedView(event.source, (current) => ({
        ...current,
        runtimeState: feedService.getRuntimeState(event.source),
      }))
      if (event.type === "subscription_updated") {
        void loadFeedSubscription(event.source)
        return
      }
      if (event.type === "sync_completed" || event.type === "sync_failed") {
        void loadFeedSubscription(event.source)
        void loadFeedItems(event.source)
      }
    })

    for (const source of FEED_SOURCES) {
      updateFeedView(source, (current) => ({
        ...current,
        runtimeState: feedService.getRuntimeState(source),
      }))
    }
    return unsubscribe
  }, [feedService, loadFeedItems, loadFeedSubscription, updateFeedView])

  useEffect(() => {
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return
    }
    if (
      shouldDeferPendingRecovery({
        isConversationStreaming: isConversationStreaming(streamingStateByConversationId, activeConversationId),
        isHydratingCompletedTurn: isActiveCompletedTurnHydrating,
      })
    ) {
      return
    }
    const pendingUserMessage = getLastPendingUserMessage(activeMessages)
    if (!pendingUserMessage) {
      attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = ""
      autoRetriedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = ""
      clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, activeConversationId)
      setPendingRecoverySyncingForConversation(activeConversationId, false)
      setPendingRecoveryPreviewForConversation(activeConversationId, "")
      return
    }
    const attemptedMessageId =
      attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] || ""
    if (attemptedMessageId === pendingUserMessage.id) {
      return
    }
    attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = pendingUserMessage.id
    void (async () => {
      const outcome = await attemptRecoverPendingAssistant(activeConversationId, activeMessages)
      if (outcome !== "none") {
        return
      }
      const shouldContinue = shouldContinuePendingRecoveryAfterNoneResult(
        pendingRecoveryNoneRetryTrackerRef.current,
        activeConversationId,
        pendingUserMessage.id,
        PENDING_RECOVERY_NONE_RESULT_MAX_RETRIES
      )
      if (shouldContinue) {
        setPendingRecoverySyncingForConversation(activeConversationId, true)
      }
    })()
  }, [
    activeConversationId,
    activeMessages,
    attemptRecoverPendingAssistant,
    setPendingRecoveryPreviewForConversation,
    setPendingRecoverySyncingForConversation,
    isActiveCompletedTurnHydrating,
    streamingStateByConversationId,
  ])

  useEffect(() => {
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return
    }
    if (!isActivePendingRecoverySyncing) {
      return
    }
    if (
      shouldDeferPendingRecovery({
        isConversationStreaming: isConversationStreaming(streamingStateByConversationId, activeConversationId),
        isHydratingCompletedTurn: isActiveCompletedTurnHydrating,
      })
    ) {
      return
    }

    const timer = window.setInterval(() => {
      const latestMessages = messagesByConversationIdRef.current[activeConversationId] || []
      const pendingUserMessage = getLastPendingUserMessage(latestMessages)
      if (!pendingUserMessage) {
        setPendingRecoverySyncingForConversation(activeConversationId, false)
        setPendingRecoveryPreviewForConversation(activeConversationId, "")
        attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = ""
        autoRetriedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = ""
        clearPendingRecoveryNoneRetryBudget(pendingRecoveryNoneRetryTrackerRef.current, activeConversationId)
        return
      }
      void (async () => {
        const outcome = await attemptRecoverPendingAssistant(activeConversationId, latestMessages)
        if (outcome !== "none") {
          return
        }
        const shouldContinue = shouldContinuePendingRecoveryAfterNoneResult(
          pendingRecoveryNoneRetryTrackerRef.current,
          activeConversationId,
          pendingUserMessage.id,
          PENDING_RECOVERY_NONE_RESULT_MAX_RETRIES
        )
        if (shouldContinue) {
          setPendingRecoverySyncingForConversation(activeConversationId, true)
        }
      })()
    }, PENDING_RECOVERY_POLL_INTERVAL_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [
    activeConversationId,
    attemptRecoverPendingAssistant,
    isActiveCompletedTurnHydrating,
    isActivePendingRecoverySyncing,
    setPendingRecoveryPreviewForConversation,
    setPendingRecoverySyncingForConversation,
    streamingStateByConversationId,
  ])

  useEffect(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    if (isThinkingStreaming && activeLeadAnchorMessageId && shouldAutoScrollRef.current) {
      const raf = window.requestAnimationFrame(() => {
        const anchorId = activeLeadAnchorMessageId
        if (!anchorId) {
          return
        }
        const anchor = node.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`)
        if (!anchor) {
          return
        }
        // Keep the latest user question pinned near top while thinking is streaming.
        setProgrammaticScrollTop(node, Math.max(0, anchor.offsetTop - 24))
      })
      return () => window.cancelAnimationFrame(raf)
    }
    if (!shouldAutoScrollRef.current) {
      return
    }
    setProgrammaticScrollTop(node, node.scrollHeight)
  }, [activeLeadAnchorMessageId, isThinkingStreaming, setProgrammaticScrollTop, activeStreamingAssistantText, visibleMessages])

  // ResizeObserver: auto-scroll on content height changes (image loads, layout shifts)
  useEffect(() => {
    if (!isActiveConversationStreaming) {
      return
    }
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!shouldAutoScrollRef.current) {
        return
      }
      if (isThinkingStreaming && activeLeadAnchorMessageId) {
        return
      }
      setProgrammaticScrollTop(node, node.scrollHeight)
    })
    // Observe the inner content container for size changes
    const inner = node.firstElementChild
    if (inner) {
      observer.observe(inner)
    }
    return () => observer.disconnect()
  }, [activeLeadAnchorMessageId, isActiveConversationStreaming, isThinkingStreaming, setProgrammaticScrollTop])


  const handleSendMessage = useCallback(
    async (
      text: string,
      attachments?: File[],
      options?: {
        retryExistingUserMessageId?: string
        conversationId?: string
        turnAttachments?: ChatTurnAttachmentInput[]
        messageAttachments?: ChatAttachment[]
        modelId?: string
      }
    ): Promise<void> => {
      const content = text.trim()
      const selectedFileAttachments = Array.isArray(attachments)
        ? attachments.filter((file) => Boolean(file))
        : []
      const explicitTurnAttachments = Array.isArray(options?.turnAttachments)
        ? options.turnAttachments.filter((attachment) => Boolean(attachment))
        : []
      const turnAttachments =
        explicitTurnAttachments.length > 0 ? explicitTurnAttachments : selectedFileAttachments
      const retryExistingUserMessageId = options?.retryExistingUserMessageId?.trim() || ""
      const targetConversationId = options?.conversationId?.trim() || ""
      const effectiveModelId = options?.modelId?.trim() || selectedModel
      if (!content && turnAttachments.length === 0) {
        return
      }
      const conversationId = targetConversationId || (await ensureConversation())
      if (isConversationStreaming(streamingStateByConversationId, conversationId)) {
        return
      }
      const explicitMessageAttachments = Array.isArray(options?.messageAttachments)
        ? options.messageAttachments.filter((attachment) => Boolean(attachment))
        : []
      const messageAttachments =
        explicitMessageAttachments.length > 0
          ? explicitMessageAttachments
          : await buildChatAttachments(selectedFileAttachments)
      const optimisticContent =
        selectedFileAttachments.length > 0 ? buildUserMessageContent(content, selectedFileAttachments) : content
      clearLastErrorForConversation(conversationId)
      const current = conversations.find((item) => item.id === conversationId)
      const currentMessages = messagesByConversationId[conversationId] || []
      const resolvedAnchors = resolveSendAnchors(conversationId, current, currentMessages)
      const anchors: Partial<ChatAnchors> = resolvedAnchors
      const clientTurnId = `turn_${crypto.randomUUID()}`

      const optimisticMessage: DomainChatMessage | null = retryExistingUserMessageId
        ? null
        : {
            id: `tmp_usr_${crypto.randomUUID()}`,
            role: "user",
            content: optimisticContent,
            ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
            createdAt: Date.now(),
            status: "completed",
          }
      shouldAutoScrollRef.current = activeConversationIdRef.current === conversationId
      if (optimisticMessage) {
        appendMessageForConversation(conversationId, optimisticMessage)
      }

      const clearStreamingState = () => {
        delete abortControllerByConversationIdRef.current[conversationId]
        removeStreamingStateForConversation(conversationId)
      }

      const streamRuntime = createChatStreamRuntime({
        leadAnchorMessageId: retryExistingUserMessageId || optimisticMessage?.id || null,
        setStreamingState: (state) => {
          setStreamingStateForConversation(conversationId, state)
        },
        patchStreamingState: (patch) => {
          patchStreamingStateForConversation(conversationId, patch)
        },
        clearStreamingState,
      })

      const controller = new AbortController()
      abortControllerByConversationIdRef.current[conversationId] = controller

      try {
        await chatService.streamTurn(
          {
            model: effectiveModelId,
            text: content,
            attachments: turnAttachments,
            ...(messageAttachments.length > 0 ? { messageAttachments } : {}),
            anchors,
            clientTurnId,
            retryExistingUserMessage: Boolean(retryExistingUserMessageId),
          },
          (event) => {
            if (event.type === "heartbeat") {
              streamRuntime.handleHeartbeat(event.meta.ts)
              return
            }

            if (event.type === "delta") {
              streamRuntime.handleDelta(event.textDelta)
              return
            }

            if (event.type === "reasoning") {
              streamRuntime.handleReasoning(event.detail)
              return
            }

            if (event.type === "completed") {
              setCompletedTurnHydratingForConversation(conversationId, true)
              setPendingRecoverySyncingForConversation(conversationId, false)
              setPendingRecoveryPreviewForConversation(conversationId, "")
              setConversations((previous) => {
                const now = Date.now()
                const targetIndex = previous.findIndex((item) => item.id === conversationId)
                if (targetIndex >= 0) {
                  const currentConversation = previous[targetIndex]
                  const next = [...previous]
                  next[targetIndex] = {
                    ...currentConversation,
                    anchors: {
                      ...currentConversation.anchors,
                      ...event.result.anchors,
                    },
                    updatedAt: now,
                  }
                  return next
                }
                return [
                  {
                    id: conversationId,
                    title: "",
                    starred: false,
                    anchors: event.result.anchors,
                    createdAt: now,
                    updatedAt: now,
                  },
                  ...previous,
                ]
              })
              const completedAssistantMessage = event.result.assistantMessage
              const completion = streamRuntime.finalize(completedAssistantMessage)
              persistCompletedReasoning({
                conversationId,
                assistantMessage: completedAssistantMessage,
                reasoningSnapshot: completion.reasoningSnapshot,
                finalDurationSeconds: completion.finalDurationSeconds,
                shouldPersistReasoningDuration: completion.shouldPersistReasoningDuration,
                upsertPersistedReasoningEntry,
                upsertPersistedReasoningDurationEntry,
              })
              shouldAutoScrollRef.current = true
              const scrollNode = messagesScrollRef.current
              if (scrollNode) {
                setProgrammaticScrollTop(scrollNode, scrollNode.scrollHeight)
              }
              void hydrateCompletedTurnConversation(conversationId, "完成后刷新消息失败")
              return
            }

            if (event.type === "failed") {
              streamRuntime.clear()
              if (event.code === "turn_in_progress") {
                setPendingRecoverySyncingForConversation(conversationId, true)
                setLastErrorForConversation(conversationId, "上一轮仍在处理中，正在自动同步结果。")
              } else {
                setLastErrorForConversation(conversationId, event.message)
              }
            }
          },
          controller.signal
        )
      } catch (error) {
        const wasAborted = controller.signal.aborted
        streamRuntime.clear()
        if (wasAborted) {
          setPendingRecoverySyncingForConversation(conversationId, true)
          setLastErrorForConversation(conversationId, "已终止，正在自动同步结果。")
          return
        }
        setLastErrorForConversation(conversationId, error instanceof Error ? error.message : "chat_stream_error")
      }
    },
    [
      appendMessageForConversation,
      chatService,
      clearLastErrorForConversation,
      conversations,
      ensureConversation,
      loadMessages,
      messagesByConversationId,
      patchStreamingStateForConversation,
      removeStreamingStateForConversation,
      setProgrammaticScrollTop,
      setStreamingStateForConversation,
      setConversations,
      setLastErrorForConversation,
      setPendingRecoverySyncingForConversation,
      refreshConversations,
      selectedModel,
      streamingStateByConversationId,
      upsertPersistedReasoningDurationEntry,
      upsertPersistedReasoningEntry,
    ]
  )

  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage
  }, [handleSendMessage])

  const handleVoiceRuntimeEvent = useCallback(
    async (event: ChatInputVoiceRuntimeEvent): Promise<void> => {
      const conversationId = event.conversationId.trim()
      if (!conversationId || conversationId === DRAFT_CONVERSATION_ID) {
        return
      }

      if (event.type === "issued") {
        clearLastErrorForConversation(conversationId)
        clearVoiceAssistantStreamingState(conversationId)
        await upsertConversationAnchors(conversationId, {
          ...(event.snapshot.sessionId.trim() ? { sessionId: event.snapshot.sessionId.trim() } : {}),
        })
        await upsertVoiceSessionRecord(conversationId, event, "issued")
        await refreshConversations()
        return
      }

      if (event.type === "connected") {
        clearLastErrorForConversation(conversationId)
        await upsertVoiceSessionRecord(conversationId, event, "connected")
        return
      }

      if (event.type === "disconnected") {
        clearVoiceAssistantStreamingState(conversationId)
        await upsertVoiceSessionRecord(conversationId, event, "closed")
        return
      }

      if (event.type === "error") {
        clearVoiceAssistantStreamingState(conversationId)
        setLastErrorForConversation(conversationId, event.error)
        await upsertVoiceSessionRecord(conversationId, event, "failed")
        return
      }

      if (event.event.role === "assistant" && Array.isArray(event.event.cards) && event.event.cards.length > 0) {
        const currentStreamingState = getConversationStreamingState(
          streamingStateByConversationIdRef.current,
          conversationId
        )
        if (!currentStreamingState) {
          const backfilled = await backfillPersistedVoiceAssistantCards(
            conversationId,
            event.event.responseId || "",
            event.event.cards
          )
          if (backfilled && !event.event.text.trim()) {
            await refreshConversationCaches(conversationId)
            return
          }
        }
        appendVoiceAssistantCards(conversationId, event.event.responseId || "", event.event.cards)
        if (!event.event.text.trim()) {
          return
        }
      }

      if (event.event.role === "assistant" && !event.event.final) {
        const currentTracker =
          voiceAssistantDeltaTrackerByConversationRef.current[conversationId] || null
        const trackerDecision = resolveVoiceAssistantDeltaTracker(currentTracker, {
          responseId: event.event.responseId,
          source: event.event.source,
        })
        const currentResponseId = currentTracker?.responseId.trim() || ""
        const nextResponseId = trackerDecision.next.responseId.trim()
        if (currentResponseId && nextResponseId && currentResponseId !== nextResponseId) {
          const latestConversations = await repository.listConversations()
          const fallbackConversation =
            latestConversations.find((item) => item.id === conversationId) ||
            conversations.find((item) => item.id === conversationId) ||
            null
          const flushed = await flushActiveVoiceAssistantStream(conversationId, fallbackConversation)
          if (flushed) {
            await refreshConversationCaches(conversationId)
          }
        }
        voiceAssistantDeltaTrackerByConversationRef.current[conversationId] = trackerDecision.next
        if (!trackerDecision.accept) {
          return
        }
        appendVoiceAssistantDelta(conversationId, event.event.text)
        return
      }

      if (!event.event.final) {
        return
      }

      clearLastErrorForConversation(conversationId)
      const latestConversations = await repository.listConversations()
      const fallbackConversation =
        latestConversations.find((item) => item.id === conversationId) ||
        conversations.find((item) => item.id === conversationId) ||
        null

      if (event.event.role === "user") {
        await flushActiveVoiceAssistantStream(conversationId, fallbackConversation)
        await commitVoiceMessage({
          repository,
          conversationId,
          fallbackConversation,
          role: "user",
          text: event.event.text,
          voiceEventKey: event.event.voiceEventKey || "",
          sessionId: event.snapshot.sessionId || fallbackConversation?.anchors.sessionId || "",
        })
      } else {
        const currentStreamingState = getConversationStreamingState(
          streamingStateByConversationIdRef.current,
          conversationId
        )
        const assistantCards = takeVoiceAssistantCards(conversationId)
        clearVoiceAssistantStreamingState(conversationId)
        const previousResponseId =
          fallbackConversation?.anchors.lastResponseId?.trim() ||
          resolveSendAnchors(
            conversationId,
            fallbackConversation || undefined,
            messagesByConversationIdRef.current[conversationId] || []
          ).lastResponseId ||
          ""
        await commitVoiceMessage({
          repository,
          conversationId,
          fallbackConversation,
          role: "assistant",
          text: buildVoiceAssistantMessageContent(event.event.text, assistantCards),
          reasoningEvents: buildVoiceAssistantReasoningEvents(assistantCards),
          sessionId: event.snapshot.sessionId || fallbackConversation?.anchors.sessionId || "",
          responseId: event.event.responseId || "",
          previousResponseId,
          defaultTitle: buildVoiceConversationTitle(new Date(), runtime.config.timezone),
          messageCreatedAt: currentStreamingState?.startedAt || Date.now(),
        })
        const shouldMarkBound = Boolean(
          event.snapshot.conversationId.trim() || event.event.conversationId?.trim()
        )
        if (shouldMarkBound) {
          await upsertVoiceSessionRecord(conversationId, event, "bound")
        }
      }

      await refreshConversationCaches(conversationId)
    },
    [
      clearLastErrorForConversation,
      clearVoiceAssistantStreamingState,
      conversations,
      appendVoiceAssistantDelta,
      appendVoiceAssistantCards,
      backfillPersistedVoiceAssistantCards,
      flushActiveVoiceAssistantStream,
      takeVoiceAssistantCards,
      refreshConversationCaches,
      refreshConversations,
      repository,
      setLastErrorForConversation,
      upsertConversationAnchors,
      upsertVoiceSessionRecord,
      runtime.config.timezone,
    ]
  )

  const handleRegenerateMessage = useCallback(
    async (targetMessage: RenderChatMessage): Promise<void> => {
      const conversationId = activeConversationIdRef.current
      if (!conversationId || conversationId === DRAFT_CONVERSATION_ID) {
        return
      }
      if (isConversationStreaming(streamingStateByConversationId, conversationId)) {
        return
      }
      const currentMessages = messagesByConversationId[conversationId] || []
      const targetIndex = currentMessages.findIndex(
        (item) => item.id === targetMessage.id && item.role === "assistant"
      )
      if (targetIndex < 0) {
        return
      }
      const targetAssistant = currentMessages[targetIndex]
      if (!targetAssistant || targetAssistant.role !== "assistant") {
        return
      }

      let previousUserIndex = -1
      for (let index = targetIndex - 1; index >= 0; index -= 1) {
        if (currentMessages[index]?.role === "user") {
          previousUserIndex = index
          break
        }
      }
      if (previousUserIndex < 0) {
        setLastErrorForConversation(conversationId, "重试失败：未找到对应用户问题")
        return
      }

      const leadAnchorMessageId = currentMessages[previousUserIndex]?.id || null
      const currentConversation =
        conversations.find((item) => item.id === conversationId) || null
      const sessionId =
        currentConversation?.anchors.sessionId?.trim() ||
        `sess_${conversationId}`

      let targetResponseId = targetAssistant.responseId?.trim() || ""
      let parentResponseId = (() => {
        const direct = targetAssistant.previousResponseId?.trim()
        if (direct) {
          return direct
        }
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
          const item = currentMessages[index]
          if (!item || item.role !== "assistant") {
            continue
          }
          const responseId = item.responseId?.trim() || ""
          if (responseId) {
            return responseId
          }
        }
        return ""
      })()

      try {
        const resolvedTarget = await chatService.resolveRegenerateTarget({
          conversationId,
          sessionId,
          messageId: targetAssistant.id,
        })
        if (resolvedTarget.responseId.trim()) {
          targetResponseId = resolvedTarget.responseId.trim()
        }
        if (resolvedTarget.previousResponseId.trim()) {
          parentResponseId = resolvedTarget.previousResponseId.trim()
        }
      } catch {
        // Keep local snapshot as fallback when session alignment probe fails.
      }

      if (!targetResponseId) {
        setLastErrorForConversation(conversationId, "重试失败：缺少目标回复 ID")
        return
      }

      const clientTurnId = `turn_${crypto.randomUUID()}`

      clearLastErrorForConversation(conversationId)

      const clearStreamingState = () => {
        delete abortControllerByConversationIdRef.current[conversationId]
        removeStreamingStateForConversation(conversationId)
      }

      const streamRuntime = createChatStreamRuntime({
        leadAnchorMessageId,
        setStreamingState: (state) => {
          setStreamingStateForConversation(conversationId, state)
        },
        patchStreamingState: (patch) => {
          patchStreamingStateForConversation(conversationId, patch)
        },
        clearStreamingState,
      })

      const controller = new AbortController()
      abortControllerByConversationIdRef.current[conversationId] = controller
      shouldAutoScrollRef.current = activeConversationIdRef.current === conversationId

      try {
        await chatService.streamTurn(
          {
            model: selectedModel,
            text: "",
            anchors: {
              conversationId,
              sessionId,
              lastResponseId: parentResponseId,
            },
            clientTurnId,
            regenerateTargetResponseId: targetResponseId,
          },
          (event) => {
            if (event.type === "heartbeat") {
              streamRuntime.handleHeartbeat(event.meta.ts)
              return
            }

            if (event.type === "delta") {
              streamRuntime.handleDelta(event.textDelta)
              return
            }

            if (event.type === "reasoning") {
              streamRuntime.handleReasoning(event.detail)
              return
            }

            if (event.type === "completed") {
              setCompletedTurnHydratingForConversation(conversationId, true)
              setPendingRecoverySyncingForConversation(conversationId, false)
              setPendingRecoveryPreviewForConversation(conversationId, "")
              const completedAssistantMessage = event.result.assistantMessage
              const completion = streamRuntime.finalize(completedAssistantMessage)
              persistCompletedReasoning({
                conversationId,
                assistantMessage: completedAssistantMessage,
                reasoningSnapshot: completion.reasoningSnapshot,
                finalDurationSeconds: completion.finalDurationSeconds,
                shouldPersistReasoningDuration: completion.shouldPersistReasoningDuration,
                upsertPersistedReasoningEntry,
                upsertPersistedReasoningDurationEntry,
              })
              shouldAutoScrollRef.current = true
              void hydrateCompletedTurnConversation(conversationId, "重生成刷新失败")
              return
            }

            if (event.type === "failed") {
              streamRuntime.clear()
              if (event.code === "turn_in_progress") {
                setPendingRecoverySyncingForConversation(conversationId, true)
                setLastErrorForConversation(conversationId, "上一轮仍在处理中，正在自动同步结果。")
              } else {
                setLastErrorForConversation(conversationId, event.message)
              }
            }
          },
          controller.signal
        )
      } catch (error) {
        const wasAborted = controller.signal.aborted
        streamRuntime.clear()
        if (wasAborted) {
          return
        }
        setLastErrorForConversation(conversationId, error instanceof Error ? error.message : "chat_stream_error")
      }
    },
    [
      chatService,
      clearLastErrorForConversation,
      conversations,
      loadMessages,
      messagesByConversationId,
      patchStreamingStateForConversation,
      refreshConversations,
      removeStreamingStateForConversation,
      repository,
      selectedModel,
      setLastErrorForConversation,
      setPendingRecoverySyncingForConversation,
      setMessagesForConversation,
      setPersistedReasoningDurationForConversation,
      setPersistedReasoningForConversation,
      setProgrammaticScrollTop,
      setStreamingStateForConversation,
      streamingStateByConversationId,
      upsertPersistedReasoningDurationEntry,
      upsertPersistedReasoningEntry,
    ]
  )

  const handleSelectConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      setActiveMainView("chat")
      if (conversationId === activeConversationIdRef.current) {
        return
      }
      if (conversationId === DRAFT_CONVERSATION_ID) {
        resetComposerForNewConversation()
        setHasDraftConversation(true)
        setDraftConversationUpdatedAt(draftConversationUpdatedAt || Date.now())
        setActiveConversationId(DRAFT_CONVERSATION_ID)
        clearMessagesForConversation(DRAFT_CONVERSATION_ID)
        return
      }
      setActiveConversationId(conversationId)
      const isSelectedConversationStreaming = isConversationStreaming(streamingStateByConversationId, conversationId)
      if (!isSelectedConversationStreaming) {
        await loadMessages(conversationId)
      }
    },
    [
      clearMessagesForConversation,
      draftConversationUpdatedAt,
      loadMessages,
      resetComposerForNewConversation,
      setActiveConversationId,
      setDraftConversationUpdatedAt,
      setHasDraftConversation,
      streamingStateByConversationId,
    ]
  )

  const handleSelectFeed = useCallback(
    async (source: FeedSource): Promise<void> => {
      setActiveMainView("feed")
      setActiveFeedSource(source)
      const current = feedViewBySourceRef.current[source]
      if (!current.loadedOnce || current.items.length === 0) {
        await loadFeedItems(source)
      }
    },
    [loadFeedItems]
  )

  const handleDeepResearchFeedItem = useCallback(
    async (item: FeedItemRecord): Promise<void> => {
      const source = item.source
      const current = feedViewBySourceRef.current[source]
      if (current.researchingItemId) {
        return
      }
      const prompt = buildFeedResearchPrompt(item)
      const turnAttachments = buildFeedResearchImageAttachments(item)
      const messageAttachments = buildFeedResearchMessageAttachments(item)
      const thinkerModelId = resolveThinkerModelId(modelOptions, selectedModel) || selectedModel

      updateFeedView(source, (value) => ({
        ...value,
        researchingItemId: item.id,
      }))
      try {
        setActiveMainView("chat")
        if (thinkerModelId && thinkerModelId !== selectedModel) {
          setSelectedModel(thinkerModelId)
        }
        const conversationId = await createConversation("")
        await handleSendMessage(prompt, [], {
          conversationId,
          turnAttachments,
          messageAttachments,
          modelId: thinkerModelId,
        })
      } finally {
        updateFeedView(source, (value) => ({
          ...value,
          researchingItemId: null,
        }))
      }
    },
    [
      modelOptions,
      buildFeedResearchPrompt,
      createConversation,
      handleSendMessage,
      selectedModel,
      setActiveMainView,
      setSelectedModel,
      updateFeedView,
    ]
  )

  const handleNewConversation = useCallback(() => {
    setActiveMainView("chat")
    if (activeConversationIdRef.current === DRAFT_CONVERSATION_ID) {
      clearMessagesForConversation(DRAFT_CONVERSATION_ID)
      return
    }
    resetComposerForNewConversation()
    setHasDraftConversation(true)
    setDraftConversationUpdatedAt(Date.now())
    setActiveConversationId(DRAFT_CONVERSATION_ID)
    clearMessagesForConversation(DRAFT_CONVERSATION_ID)
  }, [
    clearMessagesForConversation,
    resetComposerForNewConversation,
    setActiveConversationId,
    setDraftConversationUpdatedAt,
    setHasDraftConversation,
  ])

  const handleRenameConversation = useCallback(
    async (conversationId: string, title: string): Promise<void> => {
      const nextTitle = title.trim()
      if (!nextTitle) {
        return
      }
      const current = conversations.find((item) => item.id === conversationId)
      if (!current || current.title === nextTitle) {
        return
      }
      await repository.updateConversationTitle(conversationId, nextTitle)
      await refreshConversations()
    },
    [conversations, refreshConversations, repository]
  )

  const handleToggleConversationStar = useCallback(
    async (conversationId: string, starred: boolean): Promise<void> => {
      const current = conversations.find((item) => item.id === conversationId)
      if (!current || current.starred === starred) {
        return
      }
      await repository.updateConversationStarred(conversationId, starred)
      await refreshConversations()
    },
    [conversations, refreshConversations, repository]
  )

  const handleDeleteConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (isConversationStreaming(streamingStateByConversationId, conversationId)) {
        return
      }
      if (conversationId === DRAFT_CONVERSATION_ID) {
        setHasDraftConversation(false)
        setDraftConversationUpdatedAt(0)
        removeConversationCaches(DRAFT_CONVERSATION_ID)
        if (activeConversationIdRef.current === DRAFT_CONVERSATION_ID) {
          if (conversations.length === 0) {
            setActiveConversationId(null)
            return
          }
          const nextConversationId = conversations[0]?.id || null
          if (!nextConversationId) {
            setActiveConversationId(null)
            return
          }
          setActiveConversationId(nextConversationId)
          if (!isConversationStreaming(streamingStateByConversationId, nextConversationId)) {
            await loadMessages(nextConversationId)
          }
        }
        return
      }
      await repository.deleteConversation(conversationId)
      const list = await refreshConversations()
      removeConversationCaches(conversationId)

      if (activeConversationIdRef.current !== conversationId) {
        return
      }

      if (list.length === 0) {
        if (hasDraftConversation) {
          setActiveConversationId(DRAFT_CONVERSATION_ID)
        } else {
          setActiveConversationId(null)
        }
        return
      }

      const nextConversationId = list[0].id
      setActiveConversationId(nextConversationId)
      if (!isConversationStreaming(streamingStateByConversationId, nextConversationId)) {
        await loadMessages(nextConversationId)
      }
    },
    [
      conversations,
      hasDraftConversation,
      loadMessages,
      refreshConversations,
      removeConversationCaches,
      repository,
      setActiveConversationId,
      setDraftConversationUpdatedAt,
      setHasDraftConversation,
      streamingStateByConversationId,
    ]
  )

  const activeFeedView = activeFeedSource ? feedViewBySource[activeFeedSource] : null
  const unifiedFeedSidebarItem = buildUnifiedFeedSidebarItem({
    bySource: {
      polymarket: {
        enabled: feedViewBySource.polymarket.subscription?.enabled === true,
        isSyncing: feedViewBySource.polymarket.runtimeState.isSyncing,
      },
      kalshi: {
        enabled: feedViewBySource.kalshi.subscription?.enabled === true,
        isSyncing: feedViewBySource.kalshi.runtimeState.isSyncing,
      },
    },
  })
  const activeSidebarId = activeMainView === "feed" ? FEED_SIDEBAR_ID : activeConversationId

  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <div className="shrink-0">
        <ChatSidebar
          feedItems={[unifiedFeedSidebarItem]}
          conversations={sidebarConversations}
          activeId={activeSidebarId}
          onSelect={(id) => void handleSelectConversation(id)}
          onSelectFeed={() => {
            void handleSelectFeed(resolvePrimaryFeedSource(activeFeedSource))
          }}
          onNew={() => void handleNewConversation()}
          onRename={(id, title) => void handleRenameConversation(id, title)}
          onToggleStar={(id, starred) => void handleToggleConversationStar(id, starred)}
          onDelete={(id) => void handleDeleteConversation(id)}
          onOpenSettings={() => openSettings()}
          disableConversationActions={false}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
        />
      </div>

      <div data-chat-main-pane="true" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeMainView !== "feed" ? (
          <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <ModelSelector
              models={modelOptions}
              selectedModel={selectedModel}
              onModelChange={(modelId) => {
                setSelectedModel(modelId)
              }}
              onRefresh={() => {
                void refreshModelOptions()
              }}
              isRefreshing={isRefreshingModels}
              refreshStatusMessage={modelSyncNotice?.message}
              refreshStatusTone={modelSyncNotice?.tone}
            />
            <div className="flex min-w-0 items-center gap-2">
              {readyUpdateVersion ? (
                <button
                  type="button"
                  onClick={() => {
                    void installReadyUpdate()
                  }}
                  disabled={isInstallingPreparedUpdate}
                  className="inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 px-4 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/60"
                >
                  {isInstallingPreparedUpdate ? "更新中..." : "立即更新"}
                </button>
              ) : null}
              {shouldShowHeaderNewConversationButton ? (
                <div className="group/new-chat relative ms-1">
                  <span className="pointer-events-none absolute top-[calc(100%+8px)] right-0 z-20 -translate-y-1 whitespace-nowrap rounded-[16px] border border-black/10 bg-background/96 px-4 py-1 text-sm leading-6 text-foreground opacity-0 shadow-sm backdrop-blur transition-all duration-200 ease-in-out group-hover/new-chat:translate-y-0 group-hover/new-chat:opacity-100 group-focus-within/new-chat:translate-y-0 group-focus-within/new-chat:opacity-100">
                    新建聊天
                  </span>
                  <button
                    type="button"
                    onClick={handleNewConversation}
                    aria-label="新建对话"
                    className="inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-border/80 bg-background p-2 text-foreground transition-colors duration-100 hover:bg-secondary"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      className="stroke-[2]"
                      strokeWidth="2"
                    >
                      <path
                        d="M10 4V4C8.13623 4 7.20435 4 6.46927 4.30448C5.48915 4.71046 4.71046 5.48915 4.30448 6.46927C4 7.20435 4 8.13623 4 10V13.6C4 15.8402 4 16.9603 4.43597 17.816C4.81947 18.5686 5.43139 19.1805 6.18404 19.564C7.03968 20 8.15979 20 10.4 20H14C15.8638 20 16.7956 20 17.5307 19.6955C18.5108 19.2895 19.2895 18.5108 19.6955 17.5307C20 16.7956 20 15.8638 20 14V14"
                        stroke="currentColor"
                        strokeLinecap="square"
                      />
                      <path
                        d="M12.4393 14.5607L19.5 7.5C20.3284 6.67157 20.3284 5.32843 19.5 4.5C18.6716 3.67157 17.3284 3.67157 16.5 4.5L9.43934 11.5607C9.15804 11.842 9 12.2235 9 12.6213V15H11.3787C11.7765 15 12.158 14.842 12.4393 14.5607Z"
                        stroke="currentColor"
                        strokeLinecap="square"
                      />
                    </svg>
                  </button>
                </div>
              ) : null}
            </div>
          </header>
        ) : null}

        {activeMainView === "feed" && activeFeedSource && activeFeedView ? (
          <FeedPane
            source={activeFeedSource}
            subscription={activeFeedView.subscription}
            items={activeFeedView.items}
            isLoading={activeFeedView.isLoading}
            isSyncing={activeFeedView.runtimeState.isSyncing}
            hasMore={activeFeedView.hasMore}
            researchingItemId={activeFeedView.researchingItemId}
            onRefresh={() => {
              void feedService
                .syncNow(activeFeedSource)
                .then(() => loadFeedItems(activeFeedSource))
                .catch(() => {})
            }}
            onLoadMore={() => {
              if (!activeFeedView.hasMore || activeFeedView.isLoading) {
                return
              }
              void loadFeedItems(activeFeedSource, {
                append: true,
                cursor: activeFeedView.cursor,
              })
            }}
            onSelectSource={(nextSource) => {
              void handleSelectFeed(nextSource)
            }}
            onDeepResearch={(item) => {
              void handleDeepResearchFeedItem(item)
            }}
          />
        ) : (
          <div
            ref={messagesScrollRef}
            onScroll={handleMessagesScroll}
            className="flex-1 min-h-0 overflow-y-auto overscroll-y-none"
          >
            {visibleMessages.length === 0 ? (
              <WelcomeScreen />
            ) : (
              <div
                className="mx-auto w-full max-w-full transition-[max-width] duration-200 ease-out xl:max-w-[min(78%,64rem)]"
              >
                {visibleMessages.map((message) => (
                  <div key={message.id} data-message-id={message.id}>
                    {/*
                      Keep actions visible for the latest assistant response.
                      Older assistant responses only reveal actions on hover/focus.
                    */}
                    <ChatMessage
                      message={message}
                      regenerateDisabled={isActiveConversationStreaming}
                      actionsAlwaysVisible={
                        message.role === "assistant" &&
                        message.id !== "streaming_assistant" &&
                        message.id === latestAssistantMessageId
                      }
                      pdfExportMeta={
                        message.role === "assistant" && message.id !== "streaming_assistant"
                          ? pdfExportMetaByMessageId[message.id]
                          : undefined
                      }
                      onRegenerate={(target) => {
                        void handleRegenerateMessage(target)
                      }}
                    />
                  </div>
                ))}
                {activePendingRecoveryPreview ? (
                  <div data-message-id="pending_recovery_preview" className="px-6 py-2">
                    <div className="w-fit max-w-[min(92%,56rem)] rounded-3xl bg-secondary/40 px-4 py-3 text-sm leading-7 text-foreground whitespace-pre-wrap">
                      {activePendingRecoveryPreview}
                    </div>
                  </div>
                ) : null}
                {shouldShowPendingRecoveryWarmupIndicator ? (
                  <TypingIndicator label="同步中" />
                ) : null}
                {shouldShowThinkingWarmup ? (
                  <TypingIndicator elapsedSeconds={activeStreamingReasoningDurationSeconds} />
                ) : null}
                <div style={{ height: `${messageBottomSpacerPx}px` }} />
              </div>
            )}
          </div>
        )}

        {activeMainView === "chat" ? (
          <div className="shrink-0">
            <ChatInput
              onSendMessage={(text, attachments) => {
                void handleSendMessage(text, attachments)
              }}
              isLoading={isActiveConversationStreaming}
              voiceEnabled={runtime.config.voiceEnabled}
              modelOptions={modelOptions}
              selectedModel={selectedModel}
              onModelChange={(modelId) => {
                setSelectedModel(modelId)
              }}
              activeConversationId={activeConversationId}
              voiceService={runtime.services.voice}
              onPrepareVoiceSession={handlePrepareVoiceSession}
              onVoiceRuntimeEvent={(event) => {
                void handleVoiceRuntimeEvent(event)
              }}
              onHeightChange={(height) => {
                setChatInputHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height))
              }}
              onStop={() => {
                const currentConversationId = activeConversationIdRef.current
                if (!currentConversationId) {
                  return
                }
                abortControllerByConversationIdRef.current[currentConversationId]?.abort()
              }}
            />
          </div>
        ) : null}
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        requestedTab={settingsRequestedTab}
        runtime={runtime}
        onGatewayConfigChange={handleGatewayConfigChange}
        onOpenAIConfigChange={handleOpenAIConfigChange}
        onAppearanceConfigChange={handleAppearanceConfigChange}
        onPersonalizationConfigChange={handlePersonalizationConfigChange}
        onSubscriptionsConfigChange={handleSubscriptionsConfigChange}
      />
    </main>
  )
}
