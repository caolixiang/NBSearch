import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AppRuntime } from "@/app/contracts"
import type {
  ChatMessage as DomainChatMessage,
  ChatReasoningEventDetail,
} from "@/domain/chat/types"
import type { ModelOption } from "@/domain/models/types"
import type { ConversationRecord } from "@/domain/storage/repository"
import { ChatInput } from "@/components/chat-input"
import { ChatMessage, type RenderChatMessage, TypingIndicator } from "@/components/chat-message"
import { ChatSidebar } from "@/components/chat-sidebar"
import { ModelSelector } from "@/components/model-selector"
import { SettingsDialog } from "@/components/settings-dialog"
import { VoiceMode } from "@/components/voice-mode"
import { WelcomeScreen } from "@/components/welcome-screen"
import { cn } from "@/lib/utils"
import {
  getConversationStreamingState,
  isConversationStreaming,
} from "./conversation-streaming-state"
import { useChatConversationStore } from "./chat-conversation-store"
import {
  DEFAULT_MODEL_OPTIONS,
  fetchRemoteModelOptions,
  persistModelOptions,
  persistSelectedModel,
  readStoredModelOptions,
  readStoredSelectedModel,
  resolveSelectedModel,
} from "@/infrastructure/models/catalog"

function newConversationId(): string {
  return `conv_${crypto.randomUUID()}`
}

const DRAFT_CONVERSATION_ID = "draft_new_conversation"
const CHAT_INPUT_REVEAL_DELAY_MS = 500

function toRenderMessage(message: DomainChatMessage): RenderChatMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null
  }
  if (!message.content.trim()) {
    return null
  }
  return {
    id: message.id,
    role: message.role,
    content: message.content,
  }
}

function hasAnyThinkTag(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.includes("<think") || lower.includes("</think>")
}

function buildUserMessageContent(text: string, attachments?: File[]): string {
  const content = text.trim()
  const files = Array.isArray(attachments) ? attachments.filter((file) => Boolean(file)) : []
  if (files.length === 0) {
    return content
  }
  const attachmentLines = files.map((file) => `[附件] ${file.name}`)
  if (!content) {
    return attachmentLines.join("\n")
  }
  return `${content}\n\n${attachmentLines.join("\n")}`
}

function getInitialModelOptions(): ModelOption[] {
  const stored = readStoredModelOptions()
  if (stored.length > 0) {
    return stored
  }
  return DEFAULT_MODEL_OPTIONS
}

function hasOpenThinkTag(value: string): boolean {
  const lower = value.toLowerCase()
  const openIndex = lower.lastIndexOf("<think")
  if (openIndex < 0) {
    return false
  }
  const closeIndex = lower.lastIndexOf("</think>")
  return openIndex > closeIndex
}

function inferReasoningActive(events: ChatReasoningEventDetail[]): boolean {
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

  // Upstream can leave tool_usage cards unresolved (especially image tools).
  // If we received an explicit "not thinking" signal, treat it as authoritative.
  if (explicitState === false) {
    return false
  }

  if (runningToolUsageCardIds.size > 0) {
    return true
  }

  return explicitState === true
}

function appendReasoningEvent(
  previous: ChatReasoningEventDetail[],
  detail: ChatReasoningEventDetail
): ChatReasoningEventDetail[] {
  if (detail.kind === "ui_layout") {
    const previousLayout = previous.find((item): item is Extract<ChatReasoningEventDetail, { kind: "ui_layout" }> => item.kind === "ui_layout")
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
    lastErrorByConversationId,
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
  const [modelError, setModelError] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [chatInputCollapsedByScroll, setChatInputCollapsedByScroll] = useState(false)
  const [chatInputHeight, setChatInputHeight] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => getInitialModelOptions())
  const [selectedModel, setSelectedModel] = useState(() => {
    const models = getInitialModelOptions()
    return resolveSelectedModel(models, [readStoredSelectedModel(), runtime.config.defaultModel])
  })
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)

  const abortControllerByConversationIdRef = useRef<Record<string, AbortController>>({})
  const activeConversationIdRef = useRef<string | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)
  const chatInputRevealTimerRef = useRef<number | null>(null)
  const bottomLockRef = useRef(false)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

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

  const activeLastError = useMemo(() => {
    if (!activeConversationId) {
      return ""
    }
    return lastErrorByConversationId[activeConversationId] || ""
  }, [activeConversationId, lastErrorByConversationId])

  const activeStreamingState = useMemo(() => {
    return getConversationStreamingState(streamingStateByConversationId, activeConversationId)
  }, [activeConversationId, streamingStateByConversationId])

  const isActiveConversationStreaming = Boolean(activeStreamingState)
  const activeLeadAnchorMessageId = activeStreamingState?.leadAnchorMessageId || null

  const clearChatInputRevealTimer = useCallback(() => {
    if (chatInputRevealTimerRef.current) {
      window.clearTimeout(chatInputRevealTimerRef.current)
      chatInputRevealTimerRef.current = null
    }
  }, [])

  const scheduleChatInputReveal = useCallback(() => {
    clearChatInputRevealTimer()
    chatInputRevealTimerRef.current = window.setTimeout(() => {
      setChatInputCollapsedByScroll(false)
      chatInputRevealTimerRef.current = null
    }, CHAT_INPUT_REVEAL_DELAY_MS)
  }, [clearChatInputRevealTimer])

  const setProgrammaticScrollTop = useCallback((node: HTMLDivElement, nextTop: number) => {
    programmaticScrollRef.current = true
    node.scrollTop = nextTop
    lastScrollTopRef.current = node.scrollTop
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
      lastScrollTopRef.current = node.scrollTop
    })
  }, [])

  const sidebarConversations = useMemo(
    () => {
      const mapped = conversations.map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: new Date(item.updatedAt),
      }))
      if (hasDraftConversation) {
        mapped.unshift({
          id: DRAFT_CONVERSATION_ID,
          title: "",
          updatedAt: new Date(draftConversationUpdatedAt || Date.now()),
        })
      }
      return mapped
    },
    [conversations, draftConversationUpdatedAt, hasDraftConversation]
  )

  const visibleMessages = useMemo(() => {
    const rendered = activeMessages
      .map((message) => {
        const row = toRenderMessage(message)
        if (!row || row.role !== "assistant") {
          return row
        }
        const embeddedReasoningEvents =
          Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0
            ? message.reasoningEvents
            : undefined
        const byMessageId = activePersistedReasoningByMessageId[message.id]
        const byResponseId = message.responseId ? activePersistedReasoningByMessageId[message.responseId] : undefined
        const reasoningEvents = embeddedReasoningEvents || byMessageId || byResponseId
        const embeddedReasoningDuration =
          typeof message.reasoningDurationSeconds === "number" && message.reasoningDurationSeconds > 0
            ? Math.max(1, Math.round(message.reasoningDurationSeconds))
            : 0
        const durationByMessageId = activePersistedReasoningDurationByMessageId[message.id]
        const durationByResponseId = message.responseId
          ? activePersistedReasoningDurationByMessageId[message.responseId]
          : undefined
        const reasoningDurationSeconds =
          embeddedReasoningDuration || durationByMessageId || durationByResponseId || 0
        if ((!reasoningEvents || reasoningEvents.length === 0) && reasoningDurationSeconds <= 0) {
          return row
        }
        return {
          ...row,
          reasoningEvents: reasoningEvents || [],
          reasoningActive: false,
          reasoningDurationSeconds,
        }
      })
      .filter((item): item is RenderChatMessage => item !== null)

    const activeStreamingAssistantText = activeStreamingState?.assistantText || ""
    const activeStreamingReasoningEvents = activeStreamingState?.reasoningEvents || []
    const activeStreamingReasoningActive = activeStreamingState?.reasoningActive || false
    const activeStreamingReasoningDurationSeconds = activeStreamingState?.reasoningDurationSeconds || 0

    const shouldUseThinkMarkupFallback = activeStreamingReasoningEvents.length === 0
    const hasThinkMarkup = shouldUseThinkMarkupFallback && hasAnyThinkTag(activeStreamingAssistantText)
    const effectiveStreamingReasoningActive =
      hasThinkMarkup ? hasOpenThinkTag(activeStreamingAssistantText) : activeStreamingReasoningActive
    const hasRenderableStreamingAssistant =
      activeStreamingAssistantText.trim().length > 0 || effectiveStreamingReasoningActive

    if (activeStreamingState && hasRenderableStreamingAssistant) {
      rendered.push({
        id: "streaming_assistant",
        role: "assistant",
        content: activeStreamingAssistantText,
        reasoningEvents: activeStreamingReasoningEvents,
        reasoningActive: effectiveStreamingReasoningActive,
        reasoningDurationSeconds: activeStreamingReasoningDurationSeconds,
      })
    }

    return rendered
  }, [
    activeConversationId,
    activeMessages,
    activePersistedReasoningByMessageId,
    activePersistedReasoningDurationByMessageId,
    activeStreamingState,
  ])

  const activeStreamingAssistantText = activeStreamingState?.assistantText || ""
  const activeStreamingReasoningEvents = activeStreamingState?.reasoningEvents || []
  const activeStreamingReasoningActive = activeStreamingState?.reasoningActive || false
  const activeStreamingReasoningDurationSeconds = activeStreamingState?.reasoningDurationSeconds || 0

  const shouldUseThinkMarkupFallback = activeStreamingReasoningEvents.length === 0
  const hasThinkMarkup = shouldUseThinkMarkupFallback && hasAnyThinkTag(activeStreamingAssistantText)
  const effectiveStreamingReasoningActive =
    hasThinkMarkup ? hasOpenThinkTag(activeStreamingAssistantText) : activeStreamingReasoningActive
  const isThinkingStreaming = isActiveConversationStreaming && effectiveStreamingReasoningActive
  const shouldShowThinkingWarmup =
    isActiveConversationStreaming &&
    activeStreamingAssistantText.trim().length === 0 &&
    !isThinkingStreaming
  const messageBottomSpacerPx = useMemo(() => {
    const base = isThinkingStreaming ? 40 : 16
    // Keep enough trailing scroll range even when composer is auto-collapsed,
    // so the last lines can always be dragged above the bottom composer area.
    const effectiveInputHeight = chatInputHeight > 0 ? chatInputHeight : 140
    const comfortBuffer = Math.round(effectiveInputHeight * 0.72 + 20)
    return Math.max(base, Math.min(comfortBuffer, 180))
  }, [chatInputHeight, isThinkingStreaming])

  const refreshModelOptions = useCallback(
    async (silent = false): Promise<void> => {
      setIsRefreshingModels(true)
      if (!silent) {
        setModelError("")
      }
      try {
        const remoteModels = await fetchRemoteModelOptions(runtime.config)
        setModelOptions(remoteModels)
        persistModelOptions(remoteModels)
        setSelectedModel((current) =>
          resolveSelectedModel(remoteModels, [current, readStoredSelectedModel(), runtime.config.defaultModel])
        )
        setModelError("")
      } catch (error) {
        if (!silent) {
          setModelError(error instanceof Error ? error.message : "model_catalog_error")
        }
      } finally {
        setIsRefreshingModels(false)
      }
    },
    [runtime.config]
  )

  useEffect(() => {
    void refreshModelOptions(true)
  }, [refreshModelOptions])

  useEffect(() => {
    if (!selectedModel.trim()) {
      return
    }
    persistSelectedModel(selectedModel)
  }, [selectedModel])

  const refreshConversations = useCallback(async (): Promise<ConversationRecord[]> => {
    const list = await repository.listConversations()
    setConversations(list)
    return list
  }, [repository])

  const loadMessages = useCallback(
    async (conversationId: string): Promise<void> => {
      const list = await chatService.listMessages(conversationId)
      setMessagesForConversation(conversationId, list)

      const nextReasoningByMessageId: Record<string, ChatReasoningEventDetail[]> = {}
      const nextReasoningDurationByMessageId: Record<string, number> = {}

      for (const message of list) {
        if (message.role !== "assistant") {
          continue
        }
        const messageId = message.id.trim()
        const responseId = message.responseId?.trim() || ""

        if (Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0) {
          nextReasoningByMessageId[messageId] = message.reasoningEvents
          if (responseId) {
            nextReasoningByMessageId[responseId] = message.reasoningEvents
          }
        }

        if (
          typeof message.reasoningDurationSeconds === "number" &&
          Number.isFinite(message.reasoningDurationSeconds) &&
          message.reasoningDurationSeconds > 0
        ) {
          const normalizedDuration = Math.max(1, Math.round(message.reasoningDurationSeconds))
          nextReasoningDurationByMessageId[messageId] = normalizedDuration
          if (responseId) {
            nextReasoningDurationByMessageId[responseId] = normalizedDuration
          }
        }
      }

      setPersistedReasoningForConversation(conversationId, nextReasoningByMessageId)
      setPersistedReasoningDurationForConversation(conversationId, nextReasoningDurationByMessageId)
    },
    [chatService, setMessagesForConversation, setPersistedReasoningDurationForConversation, setPersistedReasoningForConversation]
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
      clearChatInputRevealTimer()
      for (const controller of Object.values(abortControllerByConversationIdRef.current)) {
        controller.abort()
      }
      abortControllerByConversationIdRef.current = {}
    }
  }, [clearChatInputRevealTimer, loadMessages, refreshConversations])

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

  const handleMessagesScroll = useCallback(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    const currentTop = node.scrollTop
    const previousTop = lastScrollTopRef.current

    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = currentTop
      return
    }

    const hasVerticalOverflow = node.scrollHeight > node.clientHeight + 8
    const delta = currentTop - previousTop
    const hasScrolled = Math.abs(delta) >= 1
    const isScrollingUp = delta < -1
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    const effectiveInputHeight = chatInputHeight > 0 ? chatInputHeight : 140
    const bottomLockEnterPx = Math.max(64, Math.min(128, Math.round(effectiveInputHeight * 0.45)))
    const bottomLockExitPx = Math.max(
      bottomLockEnterPx + 56,
      Math.min(220, Math.round(effectiveInputHeight * 0.95))
    )
    const isInBottomLockZone = distanceToBottom <= bottomLockEnterPx
    if (!hasVerticalOverflow) {
      bottomLockRef.current = false
    } else if (bottomLockRef.current) {
      // Hysteresis: once locked near bottom, require a larger move-away distance
      // before unlocking, preventing expand/collapse ping-pong at the edge.
      if (distanceToBottom > bottomLockExitPx) {
        bottomLockRef.current = false
      }
    } else if (isInBottomLockZone) {
      bottomLockRef.current = true
    }

    if (!hasVerticalOverflow || bottomLockRef.current || !isScrollingUp) {
      // Keep composer expanded when content is not scrollable, near bottom,
      // or user is scrolling down.
      clearChatInputRevealTimer()
      setChatInputCollapsedByScroll(false)
    } else if (hasScrolled && isScrollingUp) {
      // Collapse only on upward scroll.
      setChatInputCollapsedByScroll(true)
      scheduleChatInputReveal()
    }

    if (isScrollingUp) {
      // User intent wins: stop follow mode immediately to avoid jitter.
      shouldAutoScrollRef.current = false
      lastScrollTopRef.current = currentTop
      return
    }
    shouldAutoScrollRef.current = distanceToBottom < bottomLockEnterPx
    lastScrollTopRef.current = currentTop
  }, [chatInputHeight, clearChatInputRevealTimer, scheduleChatInputReveal])

  useEffect(() => {
    clearChatInputRevealTimer()
    bottomLockRef.current = false
    setChatInputCollapsedByScroll(false)
  }, [activeConversationId, clearChatInputRevealTimer])

  const handleSendMessage = useCallback(
    async (text: string, attachments?: File[]): Promise<void> => {
      const content = text.trim()
      const selectedAttachments = Array.isArray(attachments)
        ? attachments.filter((file) => Boolean(file))
        : []
      if (!content && selectedAttachments.length === 0) {
        return
      }
      const conversationId = await ensureConversation()
      if (isConversationStreaming(streamingStateByConversationId, conversationId)) {
        return
      }
      const optimisticContent = buildUserMessageContent(content, selectedAttachments)
      clearLastErrorForConversation(conversationId)
      const current = conversations.find((item) => item.id === conversationId)
      const anchors =
        current?.anchors && Object.keys(current.anchors).length > 0
          ? current.anchors
          : { conversationId }

      const optimisticMessage: DomainChatMessage = {
        id: `tmp_usr_${crypto.randomUUID()}`,
        role: "user",
        content: optimisticContent,
        createdAt: Date.now(),
        status: "completed",
      }
      shouldAutoScrollRef.current = activeConversationIdRef.current === conversationId
      appendMessageForConversation(conversationId, optimisticMessage)

      const startedAt = Date.now()
      let assistantText = ""
      let reasoningEvents: ChatReasoningEventDetail[] = []
      let reasoningActive = false
      let assistantOutputStarted = false
      let reasoningEverStarted = false
      let reasoningStopTimer: number | null = null
      let pendingCardAttachmentDetails: ChatReasoningEventDetail[] = []
      let cardAttachmentFlushTimer: number | null = null

      setStreamingStateForConversation(conversationId, {
        assistantText: "",
        reasoningEvents: [],
        reasoningActive: false,
        reasoningDurationSeconds: 0,
        startedAt,
        leadAnchorMessageId: optimisticMessage.id,
      })

      const syncStreamingState = () => {
        patchStreamingStateForConversation(conversationId, {
          assistantText,
          reasoningEvents,
          reasoningActive,
        })
      }

      const clearReasoningStopTimer = () => {
        if (reasoningStopTimer !== null) {
          window.clearTimeout(reasoningStopTimer)
          reasoningStopTimer = null
        }
      }

      const clearCardAttachmentFlushTimer = () => {
        if (cardAttachmentFlushTimer !== null) {
          window.clearTimeout(cardAttachmentFlushTimer)
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
        cardAttachmentFlushTimer = window.setTimeout(() => {
          cardAttachmentFlushTimer = null
          flushPendingCardAttachments(true)
        }, 180)
      }

      const durationTimer = window.setInterval(() => {
        const nextDuration = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        patchStreamingStateForConversation(conversationId, {
          reasoningDurationSeconds: nextDuration,
        })
      }, 1000)

      const clearStreamingState = () => {
        clearReasoningStopTimer()
        clearCardAttachmentFlushTimer()
        pendingCardAttachmentDetails = []
        window.clearInterval(durationTimer)
        delete abortControllerByConversationIdRef.current[conversationId]
        removeStreamingStateForConversation(conversationId)
      }

      const controller = new AbortController()
      abortControllerByConversationIdRef.current[conversationId] = controller

      try {
        await chatService.streamTurn(
          {
            model: selectedModel,
            text: content,
            attachments: selectedAttachments,
            anchors,
          },
          (event) => {
            if (event.type === "delta") {
              const nextText = `${assistantText}${event.textDelta}`
              assistantText = nextText
              const hasVisibleDelta = event.textDelta.trim().length > 0
              if (hasVisibleDelta) {
                assistantOutputStarted = true
              }

              // Once regular answer text starts, collapse reasoning panel immediately.
              if (
                assistantOutputStarted &&
                (reasoningEverStarted || reasoningEvents.length > 0 || reasoningActive) &&
                (!hasAnyThinkTag(nextText) || !hasOpenThinkTag(nextText))
              ) {
                clearReasoningStopTimer()
                reasoningActive = false
              }
              syncStreamingState()
              return
            }

            if (event.type === "reasoning") {
              if (event.detail.kind === "card_attachment") {
                pendingCardAttachmentDetails.push(event.detail)
                scheduleCardAttachmentFlush()
                return
              }

              flushPendingCardAttachments(false)
              reasoningEvents = appendReasoningEvent(reasoningEvents, event.detail)
              const nextReasoningActive = inferReasoningActive(reasoningEvents)
              if (nextReasoningActive && !assistantOutputStarted) {
                reasoningEverStarted = true
                clearReasoningStopTimer()
                reasoningActive = true
              } else if (assistantOutputStarted) {
                clearReasoningStopTimer()
                // Keep timeline collapsed after answer text starts.
                reasoningActive = false
              } else if (reasoningEverStarted && !assistantText.trim()) {
                clearReasoningStopTimer()
                // Sticky thinking UX: avoid pre-answer flicker when reasoning has transient gaps.
                reasoningActive = true
              } else if (reasoningStopTimer === null) {
                reasoningStopTimer = window.setTimeout(() => {
                  reasoningActive = false
                  reasoningStopTimer = null
                  syncStreamingState()
                }, 700)
              }
              syncStreamingState()
              return
            }

            if (event.type === "completed") {
              flushPendingCardAttachments(false)
              clearReasoningStopTimer()
              const completedAssistantMessage = event.result.assistantMessage
              const reasoningSnapshot = completedAssistantMessage.reasoningEvents || reasoningEvents
              const finalDurationSeconds =
                completedAssistantMessage.reasoningDurationSeconds ||
                Math.max(1, Math.round((Date.now() - startedAt) / 1000))
              const shouldPersistReasoningDuration =
                (typeof completedAssistantMessage.reasoningDurationSeconds === "number" &&
                  completedAssistantMessage.reasoningDurationSeconds > 0) ||
                reasoningEverStarted ||
                reasoningSnapshot.length > 0
              if (reasoningSnapshot.length > 0) {
                const messageId = event.result.assistantMessage.id.trim()
                const responseId = event.result.assistantMessage.responseId?.trim() || ""
                upsertPersistedReasoningEntry(conversationId, messageId, responseId, reasoningSnapshot)
                if (shouldPersistReasoningDuration) {
                  upsertPersistedReasoningDurationEntry(
                    conversationId,
                    messageId,
                    responseId,
                    finalDurationSeconds
                  )
                }
              } else if (shouldPersistReasoningDuration) {
                const messageId = event.result.assistantMessage.id.trim()
                const responseId = event.result.assistantMessage.responseId?.trim() || ""
                upsertPersistedReasoningDurationEntry(
                  conversationId,
                  messageId,
                  responseId,
                  finalDurationSeconds
                )
              }
              shouldAutoScrollRef.current = true
              clearStreamingState()
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
              clearCardAttachmentFlushTimer()
              pendingCardAttachmentDetails = []
              clearStreamingState()
              setLastErrorForConversation(conversationId, event.message)
            }
          },
          controller.signal
        )
      } catch (error) {
        const wasAborted = controller.signal.aborted
        clearStreamingState()
        if (wasAborted) {
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
      patchStreamingStateForConversation,
      removeStreamingStateForConversation,
      setProgrammaticScrollTop,
      setStreamingStateForConversation,
      setLastErrorForConversation,
      refreshConversations,
      selectedModel,
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
    [clearMessagesForConversation, draftConversationUpdatedAt, loadMessages, setActiveConversationId, setDraftConversationUpdatedAt, setHasDraftConversation, streamingStateByConversationId]
  )

  const handleNewConversation = useCallback(() => {
    if (activeConversationIdRef.current === DRAFT_CONVERSATION_ID) {
      clearMessagesForConversation(DRAFT_CONVERSATION_ID)
      return
    }
    setHasDraftConversation(true)
    setDraftConversationUpdatedAt(Date.now())
    setActiveConversationId(DRAFT_CONVERSATION_ID)
    clearMessagesForConversation(DRAFT_CONVERSATION_ID)
  }, [clearMessagesForConversation, setActiveConversationId, setDraftConversationUpdatedAt, setHasDraftConversation])

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
              setModelError("")
            }}
            onRefresh={() => {
              void refreshModelOptions()
            }}
            isRefreshing={isRefreshingModels}
          />
          {activeLastError || modelError ? (
            <span className="text-xs text-destructive">{activeLastError || modelError}</span>
          ) : (
            <div />
          )}
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
                  <ChatMessage message={message} />
                </div>
              ))}
              {shouldShowThinkingWarmup ? (
                <TypingIndicator elapsedSeconds={activeStreamingReasoningDurationSeconds} />
              ) : null}
              <div style={{ height: `${messageBottomSpacerPx}px` }} />
            </div>
          )}
        </div>

        <div
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-300 ease-out",
            chatInputCollapsedByScroll
              ? "grid-rows-[0fr] opacity-0 translate-y-3 pointer-events-none"
              : "grid-rows-[1fr] opacity-100 translate-y-0"
          )}
        >
          <div className="min-h-0">
            <ChatInput
              onSendMessage={(text, attachments) => {
                void handleSendMessage(text, attachments)
              }}
              onVoiceStart={() => setVoiceOpen(true)}
              isLoading={isActiveConversationStreaming}
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
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <VoiceMode isOpen={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </main>
  )
}
