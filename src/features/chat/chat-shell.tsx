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
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DomainChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingAssistantText, setStreamingAssistantText] = useState("")
  const [streamingReasoningEvents, setStreamingReasoningEvents] = useState<ChatReasoningEventDetail[]>([])
  const [streamingReasoningActive, setStreamingReasoningActive] = useState(false)
  const [persistedReasoningByMessageId, setPersistedReasoningByMessageId] = useState<
    Record<string, ChatReasoningEventDetail[]>
  >({})
  const [persistedReasoningDurationByMessageId, setPersistedReasoningDurationByMessageId] = useState<
    Record<string, number>
  >({})
  const [streamingReasoningDurationSeconds, setStreamingReasoningDurationSeconds] = useState(0)
  const [lastError, setLastError] = useState("")
  const [modelError, setModelError] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => getInitialModelOptions())
  const [selectedModel, setSelectedModel] = useState(() => {
    const models = getInitialModelOptions()
    return resolveSelectedModel(models, [readStoredSelectedModel(), runtime.config.defaultModel])
  })
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const activeConversationIdRef = useRef<string | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const leadAnchorMessageIdRef = useRef<string | null>(null)
  const streamingAssistantTextRef = useRef("")
  const reasoningEverStartedRef = useRef(false)
  const assistantOutputStartedRef = useRef(false)
  const streamingTurnStartedAtRef = useRef<number | null>(null)
  const streamingReasoningEventsRef = useRef<ChatReasoningEventDetail[]>([])
  const reasoningStopTimerRef = useRef<number | null>(null)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  const resolveStreamingReasoningDurationSeconds = useCallback((): number => {
    const startedAt = streamingTurnStartedAtRef.current
    if (!startedAt) {
      return 0
    }
    return Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  }, [])

  useEffect(() => {
    if (!isStreaming || !streamingTurnStartedAtRef.current) {
      return
    }
    const syncElapsed = () => {
      setStreamingReasoningDurationSeconds(resolveStreamingReasoningDurationSeconds())
    }
    syncElapsed()
    const timer = window.setInterval(syncElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [isStreaming, resolveStreamingReasoningDurationSeconds])

  const sidebarConversations = useMemo(
    () =>
      conversations.map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: new Date(item.updatedAt),
      })),
    [conversations]
  )

  const visibleMessages = useMemo(() => {
    const rendered = messages
      .map((message) => {
        const row = toRenderMessage(message)
        if (!row || row.role !== "assistant") {
          return row
        }
        const byMessageId = persistedReasoningByMessageId[message.id]
        const byResponseId = message.responseId ? persistedReasoningByMessageId[message.responseId] : undefined
        const reasoningEvents = byMessageId || byResponseId
        const durationByMessageId = persistedReasoningDurationByMessageId[message.id]
        const durationByResponseId = message.responseId
          ? persistedReasoningDurationByMessageId[message.responseId]
          : undefined
        const reasoningDurationSeconds = durationByMessageId || durationByResponseId || 0
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

    const shouldUseThinkMarkupFallback = streamingReasoningEvents.length === 0
    const hasThinkMarkup = shouldUseThinkMarkupFallback && hasAnyThinkTag(streamingAssistantText)
    const effectiveStreamingReasoningActive =
      hasThinkMarkup ? hasOpenThinkTag(streamingAssistantText) : streamingReasoningActive
    const hasRenderableStreamingAssistant =
      streamingAssistantText.trim().length > 0 || effectiveStreamingReasoningActive

    if (isStreaming && hasRenderableStreamingAssistant) {
      rendered.push({
        id: "streaming_assistant",
        role: "assistant",
        content: streamingAssistantText,
        reasoningEvents: streamingReasoningEvents,
        reasoningActive: effectiveStreamingReasoningActive,
        reasoningDurationSeconds: streamingReasoningDurationSeconds,
      })
    }

    return rendered
  }, [
    isStreaming,
    messages,
    persistedReasoningByMessageId,
    persistedReasoningDurationByMessageId,
    streamingReasoningDurationSeconds,
    streamingAssistantText,
    streamingReasoningActive,
    streamingReasoningEvents,
  ])

  const shouldUseThinkMarkupFallback = streamingReasoningEvents.length === 0
  const hasThinkMarkup = shouldUseThinkMarkupFallback && hasAnyThinkTag(streamingAssistantText)
  const effectiveStreamingReasoningActive =
    hasThinkMarkup ? hasOpenThinkTag(streamingAssistantText) : streamingReasoningActive
  const isThinkingStreaming = isStreaming && effectiveStreamingReasoningActive
  const shouldShowThinkingWarmup = isStreaming && streamingAssistantText.trim().length === 0 && !isThinkingStreaming

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
      setMessages(list)
    },
    [chatService]
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
      setActiveConversationId(id)
      await refreshConversations()
      setMessages([])
      return id
    },
    [repository, refreshConversations]
  )

  const ensureConversation = useCallback(
    async (title = ""): Promise<string> => {
      if (activeConversationIdRef.current) {
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
      if (reasoningStopTimerRef.current) {
        window.clearTimeout(reasoningStopTimerRef.current)
        reasoningStopTimerRef.current = null
      }
      abortRef.current?.abort()
    }
  }, [loadMessages, refreshConversations])

  useEffect(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    if (isThinkingStreaming && leadAnchorMessageIdRef.current) {
      const raf = window.requestAnimationFrame(() => {
        const anchorId = leadAnchorMessageIdRef.current
        if (!anchorId) {
          return
        }
        const anchor = node.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`)
        if (!anchor) {
          return
        }
        // Keep the latest user question pinned near top while thinking is streaming.
        node.scrollTop = Math.max(0, anchor.offsetTop - 24)
      })
      return () => window.cancelAnimationFrame(raf)
    }
    if (!shouldAutoScrollRef.current) {
      return
    }
    node.scrollTop = node.scrollHeight
  }, [isThinkingStreaming, streamingAssistantText, visibleMessages])

  // ResizeObserver: auto-scroll on content height changes (image loads, layout shifts)
  useEffect(() => {
    if (!isStreaming) {
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
      if (isThinkingStreaming && leadAnchorMessageIdRef.current) {
        return
      }
      node.scrollTop = node.scrollHeight
    })
    // Observe the inner content container for size changes
    const inner = node.firstElementChild
    if (inner) {
      observer.observe(inner)
    }
    return () => observer.disconnect()
  }, [isStreaming, isThinkingStreaming])

  const handleMessagesScroll = useCallback(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    if (isThinkingStreaming && leadAnchorMessageIdRef.current) {
      // Keep follow mode locked while anchor pin mode is active.
      shouldAutoScrollRef.current = true
      return
    }
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    shouldAutoScrollRef.current = distanceToBottom < 80
  }, [isThinkingStreaming])

  const handleSendMessage = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim()
      if (!content || isStreaming) {
        return
      }

      setLastError("")
      setStreamingAssistantText("")
      streamingAssistantTextRef.current = ""
      reasoningEverStartedRef.current = false
      assistantOutputStartedRef.current = false
      streamingTurnStartedAtRef.current = Date.now()
      setStreamingReasoningDurationSeconds(0)
      setStreamingReasoningEvents([])
      setStreamingReasoningActive(false)
      if (reasoningStopTimerRef.current) {
        window.clearTimeout(reasoningStopTimerRef.current)
        reasoningStopTimerRef.current = null
      }
      streamingReasoningEventsRef.current = []
      setIsStreaming(true)
      shouldAutoScrollRef.current = true

      const conversationId = await ensureConversation()
      const current = conversations.find((item) => item.id === conversationId)
      const anchors =
        current?.anchors && Object.keys(current.anchors).length > 0
          ? current.anchors
          : { conversationId }

      const optimisticMessage: DomainChatMessage = {
        id: `tmp_usr_${crypto.randomUUID()}`,
        role: "user",
        content,
        createdAt: Date.now(),
        status: "completed",
      }
      leadAnchorMessageIdRef.current = optimisticMessage.id
      setMessages((prev) => [...prev, optimisticMessage])

      const controller = new AbortController()
      abortRef.current = controller

      try {
        await chatService.streamTurn(
          {
            model: selectedModel,
            text: content,
            anchors,
          },
          (event) => {
            if (event.type === "delta") {
              const nextText = `${streamingAssistantTextRef.current}${event.textDelta}`
              streamingAssistantTextRef.current = nextText
              setStreamingAssistantText(nextText)
              const hasVisibleDelta = event.textDelta.trim().length > 0
              if (hasVisibleDelta) {
                assistantOutputStartedRef.current = true
              }

              // Once regular answer text starts, collapse reasoning panel immediately.
              if (
                assistantOutputStartedRef.current &&
                (reasoningEverStartedRef.current ||
                  streamingReasoningEventsRef.current.length > 0 ||
                  streamingReasoningActive) &&
                (!hasAnyThinkTag(nextText) || !hasOpenThinkTag(nextText))
              ) {
                if (reasoningStopTimerRef.current) {
                  window.clearTimeout(reasoningStopTimerRef.current)
                  reasoningStopTimerRef.current = null
                }
                setStreamingReasoningActive(false)
              }
              return
            }

            if (event.type === "reasoning") {
              const nextReasoningEvents = appendReasoningEvent(streamingReasoningEventsRef.current, event.detail)
              streamingReasoningEventsRef.current = nextReasoningEvents
              setStreamingReasoningEvents(nextReasoningEvents)
              const nextReasoningActive = inferReasoningActive(nextReasoningEvents)
              if (nextReasoningActive && !assistantOutputStartedRef.current) {
                reasoningEverStartedRef.current = true
                if (reasoningStopTimerRef.current) {
                  window.clearTimeout(reasoningStopTimerRef.current)
                  reasoningStopTimerRef.current = null
                }
                setStreamingReasoningActive(true)
              } else if (assistantOutputStartedRef.current) {
                if (reasoningStopTimerRef.current) {
                  window.clearTimeout(reasoningStopTimerRef.current)
                  reasoningStopTimerRef.current = null
                }
                // Keep timeline collapsed after answer text starts.
                setStreamingReasoningActive(false)
              } else if (reasoningEverStartedRef.current && !streamingAssistantTextRef.current.trim()) {
                if (reasoningStopTimerRef.current) {
                  window.clearTimeout(reasoningStopTimerRef.current)
                  reasoningStopTimerRef.current = null
                }
                // Sticky thinking UX: avoid pre-answer flicker when reasoning has transient gaps.
                setStreamingReasoningActive(true)
              } else if (!reasoningStopTimerRef.current) {
                reasoningStopTimerRef.current = window.setTimeout(() => {
                  setStreamingReasoningActive(false)
                  reasoningStopTimerRef.current = null
                }, 700)
              }
              return
            }

            if (event.type === "completed") {
              if (reasoningStopTimerRef.current) {
                window.clearTimeout(reasoningStopTimerRef.current)
                reasoningStopTimerRef.current = null
              }
              const reasoningSnapshot = streamingReasoningEventsRef.current
              const finalDurationSeconds = resolveStreamingReasoningDurationSeconds()
              const shouldPersistReasoningDuration =
                reasoningEverStartedRef.current || reasoningSnapshot.length > 0 || finalDurationSeconds > 0
              if (reasoningSnapshot.length > 0) {
                const messageId = event.result.assistantMessage.id.trim()
                const responseId = event.result.assistantMessage.responseId?.trim() || ""
                setPersistedReasoningByMessageId((prev) => ({
                  ...prev,
                  [messageId]: reasoningSnapshot,
                  ...(responseId ? { [responseId]: reasoningSnapshot } : {}),
                }))
                if (shouldPersistReasoningDuration) {
                  setPersistedReasoningDurationByMessageId((prev) => ({
                    ...prev,
                    [messageId]: finalDurationSeconds,
                    ...(responseId ? { [responseId]: finalDurationSeconds } : {}),
                  }))
                }
              } else if (shouldPersistReasoningDuration) {
                const messageId = event.result.assistantMessage.id.trim()
                const responseId = event.result.assistantMessage.responseId?.trim() || ""
                setPersistedReasoningDurationByMessageId((prev) => ({
                  ...prev,
                  [messageId]: finalDurationSeconds,
                  ...(responseId ? { [responseId]: finalDurationSeconds } : {}),
                }))
              }
              setStreamingAssistantText("")
              streamingAssistantTextRef.current = ""
              reasoningEverStartedRef.current = false
              assistantOutputStartedRef.current = false
              streamingTurnStartedAtRef.current = null
              setStreamingReasoningDurationSeconds(0)
              setStreamingReasoningEvents([])
              setStreamingReasoningActive(false)
              streamingReasoningEventsRef.current = []
              setIsStreaming(false)
              leadAnchorMessageIdRef.current = null
              void refreshConversations().then(() => {
                if (activeConversationIdRef.current === conversationId) {
                  return loadMessages(conversationId)
                }
              })
              return
            }

            if (event.type === "failed") {
              if (reasoningStopTimerRef.current) {
                window.clearTimeout(reasoningStopTimerRef.current)
                reasoningStopTimerRef.current = null
              }
              setStreamingAssistantText("")
              streamingAssistantTextRef.current = ""
              reasoningEverStartedRef.current = false
              assistantOutputStartedRef.current = false
              streamingTurnStartedAtRef.current = null
              setStreamingReasoningDurationSeconds(0)
              setStreamingReasoningEvents([])
              setStreamingReasoningActive(false)
              streamingReasoningEventsRef.current = []
              setIsStreaming(false)
              leadAnchorMessageIdRef.current = null
              setLastError(event.message)
            }
          },
          controller.signal
        )
      } catch (error) {
        if (reasoningStopTimerRef.current) {
          window.clearTimeout(reasoningStopTimerRef.current)
          reasoningStopTimerRef.current = null
        }
        setStreamingAssistantText("")
        streamingAssistantTextRef.current = ""
        reasoningEverStartedRef.current = false
        assistantOutputStartedRef.current = false
        streamingTurnStartedAtRef.current = null
        setStreamingReasoningDurationSeconds(0)
        setStreamingReasoningEvents([])
        setStreamingReasoningActive(false)
        streamingReasoningEventsRef.current = []
        setIsStreaming(false)
        leadAnchorMessageIdRef.current = null
        setLastError(error instanceof Error ? error.message : "chat_stream_error")
      } finally {
        abortRef.current = null
      }
    },
    [
      chatService,
      conversations,
      ensureConversation,
      isStreaming,
      loadMessages,
      refreshConversations,
      resolveStreamingReasoningDurationSeconds,
      selectedModel,
      streamingReasoningActive,
    ]
  )

  const handleSelectConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (isStreaming || conversationId === activeConversationIdRef.current) {
        return
      }
      if (reasoningStopTimerRef.current) {
        window.clearTimeout(reasoningStopTimerRef.current)
        reasoningStopTimerRef.current = null
      }
      setLastError("")
      setStreamingAssistantText("")
      streamingAssistantTextRef.current = ""
      reasoningEverStartedRef.current = false
      assistantOutputStartedRef.current = false
      streamingTurnStartedAtRef.current = null
      setStreamingReasoningDurationSeconds(0)
      setStreamingReasoningEvents([])
      setStreamingReasoningActive(false)
      streamingReasoningEventsRef.current = []
      leadAnchorMessageIdRef.current = null
      setActiveConversationId(conversationId)
      await loadMessages(conversationId)
    },
    [isStreaming, loadMessages]
  )

  const handleNewConversation = useCallback(async () => {
    if (isStreaming) {
      return
    }
    if (reasoningStopTimerRef.current) {
      window.clearTimeout(reasoningStopTimerRef.current)
      reasoningStopTimerRef.current = null
    }
    setLastError("")
    setStreamingAssistantText("")
    streamingAssistantTextRef.current = ""
    reasoningEverStartedRef.current = false
    assistantOutputStartedRef.current = false
    streamingTurnStartedAtRef.current = null
    setStreamingReasoningDurationSeconds(0)
    setStreamingReasoningEvents([])
    setStreamingReasoningActive(false)
    streamingReasoningEventsRef.current = []
    leadAnchorMessageIdRef.current = null
    const activeConversationId = activeConversationIdRef.current
    if (activeConversationId) {
      const current = conversations.find((item) => item.id === activeConversationId)
      const hasTitle = Boolean(current?.title.trim())
      const hasMessages = messages.some(
        (item) =>
          (item.role === "user" || item.role === "assistant") && item.content.trim().length > 0
      )
      if (!hasTitle && !hasMessages) {
        return
      }
    }
    await createConversation()
  }, [conversations, createConversation, isStreaming, messages])

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
      if (isStreaming) {
        return
      }
      await repository.deleteConversation(conversationId)
      const list = await refreshConversations()
      setLastError("")
      setStreamingAssistantText("")
      streamingAssistantTextRef.current = ""
      reasoningEverStartedRef.current = false
      assistantOutputStartedRef.current = false
      streamingTurnStartedAtRef.current = null
      setStreamingReasoningDurationSeconds(0)
      setStreamingReasoningEvents([])
      setStreamingReasoningActive(false)
      streamingReasoningEventsRef.current = []
      leadAnchorMessageIdRef.current = null

      if (activeConversationIdRef.current !== conversationId) {
        return
      }

      if (list.length === 0) {
        setActiveConversationId(null)
        setMessages([])
        return
      }

      const nextConversationId = list[0].id
      setActiveConversationId(nextConversationId)
      await loadMessages(nextConversationId)
    },
    [isStreaming, loadMessages, refreshConversations, repository]
  )

  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <ChatSidebar
        conversations={sidebarConversations}
        activeId={activeConversationId}
        onSelect={(id) => void handleSelectConversation(id)}
        onNew={() => void handleNewConversation()}
        onRename={(id, title) => void handleRenameConversation(id, title)}
        onDelete={(id) => void handleDeleteConversation(id)}
        onOpenSettings={() => setSettingsOpen(true)}
        disableConversationActions={isStreaming}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
          {lastError || modelError ? (
            <span className="text-xs text-destructive">{lastError || modelError}</span>
          ) : (
            <div />
          )}
        </header>

        <div ref={messagesScrollRef} onScroll={handleMessagesScroll} className="flex-1 min-h-0 overflow-y-auto">
          {visibleMessages.length === 0 ? (
            <WelcomeScreen />
          ) : (
            <div className="mx-auto max-w-3xl">
              {visibleMessages.map((message) => (
                <div key={message.id} data-message-id={message.id}>
                  <ChatMessage message={message} />
                </div>
              ))}
              {shouldShowThinkingWarmup ? (
                <TypingIndicator elapsedSeconds={streamingReasoningDurationSeconds} />
              ) : null}
              <div className={isThinkingStreaming ? "h-10" : "h-4"} />
            </div>
          )}
        </div>

        <ChatInput
          onSendMessage={(text) => {
            void handleSendMessage(text)
          }}
          onVoiceStart={() => setVoiceOpen(true)}
          isLoading={isStreaming}
          onStop={() => {
            abortRef.current?.abort()
            setIsStreaming(false)
            setStreamingAssistantText("")
            streamingAssistantTextRef.current = ""
            reasoningEverStartedRef.current = false
            assistantOutputStartedRef.current = false
            streamingTurnStartedAtRef.current = null
            setStreamingReasoningDurationSeconds(0)
            setStreamingReasoningEvents([])
            setStreamingReasoningActive(false)
            streamingReasoningEventsRef.current = []
            leadAnchorMessageIdRef.current = null
          }}
        />
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <VoiceMode isOpen={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </main>
  )
}
