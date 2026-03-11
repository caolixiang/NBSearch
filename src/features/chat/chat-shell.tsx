import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AppFontSizeMode, AppRuntime, AppThemeMode } from "@/app/contracts"
import { applyAppearanceSettings } from "@/app/appearance"
import { applyAppearanceConfigToRuntime, applyGatewayConfigToRuntime, applyPersonalizationConfigToRuntime } from "@/app/runtime"
import type { ChatAnchors, ChatMessage as DomainChatMessage } from "@/domain/chat/types"
import type { ConversationRecord } from "@/domain/storage/repository"
import { ChatInput, type ChatInputVoiceRuntimeEvent } from "@/components/chat-input"
import { ChatMessage, type RenderChatMessage, TypingIndicator } from "@/components/chat-message"
import { ChatSidebar } from "@/components/chat-sidebar"
import { ModelSelector } from "@/components/model-selector"
import { SettingsDialog } from "@/components/settings-dialog"
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
import { resolveFastModelId } from "./model-selection"
import { createChatStreamRuntime, persistCompletedReasoning } from "./chat-stream-runtime"
import {
  buildAssistantRoundByMessageId,
  buildPdfExportMetaByMessageId,
  buildReasoningCaches,
  buildSidebarConversationItems,
  buildStreamingReasoningViewModel,
  computeMessageBottomSpacerPx,
  buildUserMessageContent,
  buildVisibleMessages,
  extractRetryableUserText,
  findLatestAssistantMessageId,
  getLastPendingUserMessage,
  newConversationId,
  resolveVoiceResumeConversationId,
  resolveSendAnchors,
} from "./chat-shell-helpers"
import { useChatShellModels } from "./use-chat-shell-models"
import { useChatShellAppUpdate } from "./use-chat-shell-app-update"
import { useChatShellScroll } from "./use-chat-shell-scroll"
import { commitVoiceMessage } from "./voice-message-commit"
import {
  resolveVoiceAssistantDeltaTracker,
  type VoiceAssistantDeltaTracker,
} from "./voice-assistant-stream"

const DRAFT_CONVERSATION_ID = "draft_new_conversation"
const PENDING_RECOVERY_POLL_INTERVAL_MS = 2500
const PENDING_RECOVERY_NONE_RESULT_MAX_RETRIES = 24
export function ChatShell({ runtime }: { runtime: AppRuntime }) {
  const repository = runtime.services.repository
  const chatService = runtime.services.chat

  const [conversations, setConversations] = useState<ConversationRecord[]>([])
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
  const [pendingRecoverySyncingByConversationId, setPendingRecoverySyncingByConversationId] = useState<
    Record<string, boolean>
  >({})
  const [pendingRecoveryPreviewByConversationId, setPendingRecoveryPreviewByConversationId] = useState<
    Record<string, string>
  >({})
  const { readyUpdateVersion, isInstallingPreparedUpdate, installReadyUpdate } = useChatShellAppUpdate()

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
  const messagesByConversationIdRef = useRef(messagesByConversationId)
  const streamingStateByConversationIdRef = useRef(streamingStateByConversationId)
  const attemptedPendingRecoveryMessageIdByConversationRef = useRef<Record<string, string>>({})
  const autoRetriedPendingRecoveryMessageIdByConversationRef = useRef<Record<string, string>>({})
  const pendingRecoveryNoneRetryTrackerRef = useRef<PendingRecoveryNoneRetryTracker>({})
  const voiceAssistantDeltaTrackerByConversationRef = useRef<Record<string, VoiceAssistantDeltaTracker>>({})
  const handleSendMessageRef = useRef<
    | ((
        text: string,
        attachments?: File[],
        options?: {
          retryExistingUserMessageId?: string
        }
      ) => Promise<void>)
    | null
  >(null)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

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
    if (isConversationStreaming(streamingStateByConversationId, activeConversationId)) {
      return null
    }
    return getLastPendingUserMessage(activeMessages)
  }, [activeConversationId, activeMessages, streamingStateByConversationId])
  const isActivePendingRecoverySyncing = useMemo(() => {
    if (!activeConversationId) {
      return false
    }
    return Boolean(pendingRecoverySyncingByConversationId[activeConversationId])
  }, [activeConversationId, pendingRecoverySyncingByConversationId])
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
  const shouldShowPendingRecoveryWarmup =
    Boolean(activePendingUserMessage) && !isActiveConversationStreaming && isActivePendingRecoverySyncing
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

  const handlePersonalizationConfigChange = useCallback((next: { timezone: string }) => {
    applyPersonalizationConfigToRuntime(next)
  }, [])

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

  const clearVoiceAssistantStreamingState = useCallback(
    (conversationId: string) => {
      delete voiceAssistantDeltaTrackerByConversationRef.current[conversationId]
      removeStreamingStateForConversation(conversationId)
    },
    [removeStreamingStateForConversation]
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
        anchors: {
          conversationId: id,
        },
        createdAt: now,
        updatedAt: now,
      })
      setHasDraftConversation(false)
      setDraftConversationUpdatedAt(0)
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
    const conversationId = await ensureConversation()
    const latestConversations = await repository.listConversations()
    const latestConversation =
      latestConversations.find((item) => item.id === conversationId) ||
      conversations.find((item) => item.id === conversationId)
    return {
      conversationId,
      sessionId: latestConversation?.anchors.sessionId?.trim() || undefined,
      upstreamConversationId: resolveVoiceResumeConversationId(
        conversationId,
        latestConversation?.anchors
      ),
    }
  }, [conversations, ensureConversation, repository])

  useEffect(() => {
    let mounted = true

    const initialize = async () => {
      const list = await refreshConversations()
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
  }, [loadMessages, refreshConversations])

  useEffect(() => {
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return
    }
    if (isConversationStreaming(streamingStateByConversationId, activeConversationId)) {
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
    streamingStateByConversationId,
  ])

  useEffect(() => {
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return
    }
    if (!isActivePendingRecoverySyncing) {
      return
    }
    if (isConversationStreaming(streamingStateByConversationId, activeConversationId)) {
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
      }
    ): Promise<void> => {
      const content = text.trim()
      const selectedAttachments = Array.isArray(attachments)
        ? attachments.filter((file) => Boolean(file))
        : []
      const retryExistingUserMessageId = options?.retryExistingUserMessageId?.trim() || ""
      if (!content && selectedAttachments.length === 0) {
        return
      }
      const conversationId = await ensureConversation()
      if (isConversationStreaming(streamingStateByConversationId, conversationId)) {
        return
      }
      const optimisticContent = buildUserMessageContent(content, selectedAttachments)
      const messageAttachments = await buildChatAttachments(selectedAttachments)
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
            model: selectedModel,
            text: content,
            attachments: selectedAttachments,
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
              void refreshConversations().then(async () => {
                await loadMessages(conversationId)
                if (activeConversationIdRef.current === conversationId) {
                  const node = messagesScrollRef.current
                  if (node) {
                    setProgrammaticScrollTop(node, node.scrollHeight)
                  }
                }
              })
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

      if (event.event.role === "assistant" && !event.event.final) {
        const currentTracker =
          voiceAssistantDeltaTrackerByConversationRef.current[conversationId] || null
        const trackerDecision = resolveVoiceAssistantDeltaTracker(currentTracker, {
          responseId: event.event.responseId,
          source: event.event.source,
        })
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
        await commitVoiceMessage({
          repository,
          conversationId,
          fallbackConversation,
          role: "user",
          text: event.event.text,
          sessionId: event.snapshot.sessionId || fallbackConversation?.anchors.sessionId || "",
        })
      } else {
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
          text: event.event.text,
          sessionId: event.snapshot.sessionId || fallbackConversation?.anchors.sessionId || "",
          responseId: event.event.responseId || "",
          previousResponseId,
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
      refreshConversationCaches,
      refreshConversations,
      repository,
      setLastErrorForConversation,
      upsertConversationAnchors,
      upsertVoiceSessionRecord,
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
              void (async () => {
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
                  const message = error instanceof Error ? error.message : "重生成刷新失败"
                  setLastErrorForConversation(conversationId, message)
                }
              })()
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

  const handleNewConversation = useCallback(() => {
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

  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <div className="shrink-0">
        <ChatSidebar
          conversations={sidebarConversations}
          activeId={activeConversationId}
          onSelect={(id) => void handleSelectConversation(id)}
          onNew={() => void handleNewConversation()}
          onRename={(id, title) => void handleRenameConversation(id, title)}
          onDelete={(id) => void handleDeleteConversation(id)}
          onOpenSettings={() => setSettingsOpen(true)}
          disableConversationActions={false}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
        />
      </div>

      <div data-chat-main-pane="true" className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
              {shouldShowPendingRecoveryWarmup ? (
                <TypingIndicator label="同步中" />
              ) : null}
              {shouldShowThinkingWarmup ? (
                <TypingIndicator elapsedSeconds={activeStreamingReasoningDurationSeconds} />
              ) : null}
              <div style={{ height: `${messageBottomSpacerPx}px` }} />
            </div>
          )}
        </div>

        <div className="shrink-0">
          <ChatInput
            onSendMessage={(text, attachments) => {
              void handleSendMessage(text, attachments)
            }}
            isLoading={isActiveConversationStreaming}
            voiceEnabled={runtime.config.voiceEnabled}
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
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        runtime={runtime}
        onGatewayConfigChange={handleGatewayConfigChange}
        onAppearanceConfigChange={handleAppearanceConfigChange}
        onPersonalizationConfigChange={handlePersonalizationConfigChange}
      />
    </main>
  )
}
