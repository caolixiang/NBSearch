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
  const [hasDraftConversation, setHasDraftConversation] = useState(false)
  const [draftConversationUpdatedAt, setDraftConversationUpdatedAt] = useState(0)
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

  const abortRef = useRef<AbortController | null>(null)
  const activeConversationIdRef = useRef<string | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)
  const leadAnchorMessageIdRef = useRef<string | null>(null)
  const streamingAssistantTextRef = useRef("")
  const reasoningEverStartedRef = useRef(false)
  const assistantOutputStartedRef = useRef(false)
  const streamingTurnStartedAtRef = useRef<number | null>(null)
  const streamingReasoningEventsRef = useRef<ChatReasoningEventDetail[]>([])
  const reasoningStopTimerRef = useRef<number | null>(null)
  const chatInputRevealTimerRef = useRef<number | null>(null)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

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

  const resolveStreamingReasoningDurationSeconds = useCallback((): number => {
    const startedAt = streamingTurnStartedAtRef.current
    if (!startedAt) {
      return 0
    }
    return Math.max(1, Math.round((Date.now() - startedAt) / 1000))
  }, [])

  const setProgrammaticScrollTop = useCallback((node: HTMLDivElement, nextTop: number) => {
    programmaticScrollRef.current = true
    node.scrollTop = nextTop
    lastScrollTopRef.current = node.scrollTop
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
      lastScrollTopRef.current = node.scrollTop
    })
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
    const rendered = messages
      .map((message) => {
        const row = toRenderMessage(message)
        if (!row || row.role !== "assistant") {
          return row
        }
        const embeddedReasoningEvents =
          Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0
            ? message.reasoningEvents
            : undefined
        const byMessageId = persistedReasoningByMessageId[message.id]
        const byResponseId = message.responseId ? persistedReasoningByMessageId[message.responseId] : undefined
        const reasoningEvents = embeddedReasoningEvents || byMessageId || byResponseId
        const embeddedReasoningDuration =
          typeof message.reasoningDurationSeconds === "number" && message.reasoningDurationSeconds > 0
            ? Math.max(1, Math.round(message.reasoningDurationSeconds))
            : 0
        const durationByMessageId = persistedReasoningDurationByMessageId[message.id]
        const durationByResponseId = message.responseId
          ? persistedReasoningDurationByMessageId[message.responseId]
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
  const messageBottomSpacerPx = useMemo(() => {
    const base = isThinkingStreaming ? 40 : 16
    // Keep enough trailing scroll range even when composer is auto-collapsed,
    // so the last lines can always be dragged above the bottom composer area.
    const effectiveInputHeight = chatInputHeight > 0 ? chatInputHeight : 220
    const comfortBuffer = Math.round(effectiveInputHeight + 24)
    return Math.max(base, comfortBuffer)
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
      setMessages(list)

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

      setPersistedReasoningByMessageId(nextReasoningByMessageId)
      setPersistedReasoningDurationByMessageId(nextReasoningDurationByMessageId)
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
      setHasDraftConversation(false)
      setDraftConversationUpdatedAt(0)
      setActiveConversationId(id)
      await refreshConversations()
      setMessages([])
      return id
    },
    [repository, refreshConversations]
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
      if (reasoningStopTimerRef.current) {
        window.clearTimeout(reasoningStopTimerRef.current)
        reasoningStopTimerRef.current = null
      }
      clearChatInputRevealTimer()
      abortRef.current?.abort()
    }
  }, [clearChatInputRevealTimer, loadMessages, refreshConversations])

  useEffect(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    if (isThinkingStreaming && leadAnchorMessageIdRef.current && shouldAutoScrollRef.current) {
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
        setProgrammaticScrollTop(node, Math.max(0, anchor.offsetTop - 24))
      })
      return () => window.cancelAnimationFrame(raf)
    }
    if (!shouldAutoScrollRef.current) {
      return
    }
    setProgrammaticScrollTop(node, node.scrollHeight)
  }, [isThinkingStreaming, setProgrammaticScrollTop, streamingAssistantText, visibleMessages])

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
      setProgrammaticScrollTop(node, node.scrollHeight)
    })
    // Observe the inner content container for size changes
    const inner = node.firstElementChild
    if (inner) {
      observer.observe(inner)
    }
    return () => observer.disconnect()
  }, [isStreaming, isThinkingStreaming, setProgrammaticScrollTop])

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
    const hasScrolled = Math.abs(currentTop - previousTop) >= 1

    if (!hasVerticalOverflow) {
      clearChatInputRevealTimer()
      setChatInputCollapsedByScroll(false)
    } else if (hasScrolled) {
      setChatInputCollapsedByScroll(true)
      scheduleChatInputReveal()
    }

    const isScrollingUp = currentTop + 2 < previousTop
    if (isScrollingUp) {
      // User intent wins: stop follow mode immediately to avoid jitter.
      shouldAutoScrollRef.current = false
      lastScrollTopRef.current = currentTop
      return
    }
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    shouldAutoScrollRef.current = distanceToBottom < 80
    lastScrollTopRef.current = currentTop
  }, [clearChatInputRevealTimer, scheduleChatInputReveal])

  useEffect(() => {
    clearChatInputRevealTimer()
    setChatInputCollapsedByScroll(false)
  }, [activeConversationId, clearChatInputRevealTimer])

  const handleSendMessage = useCallback(
    async (text: string, attachments?: File[]): Promise<void> => {
      const content = text.trim()
      const selectedAttachments = Array.isArray(attachments)
        ? attachments.filter((file) => Boolean(file))
        : []
      if ((!content && selectedAttachments.length === 0) || isStreaming) {
        return
      }
      const optimisticContent = buildUserMessageContent(content, selectedAttachments)

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
        content: optimisticContent,
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
            attachments: selectedAttachments,
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
              const completedAssistantMessage = event.result.assistantMessage
              const reasoningSnapshot =
                completedAssistantMessage.reasoningEvents || streamingReasoningEventsRef.current
              const finalDurationSeconds =
                completedAssistantMessage.reasoningDurationSeconds ||
                resolveStreamingReasoningDurationSeconds()
              const shouldPersistReasoningDuration =
                (typeof completedAssistantMessage.reasoningDurationSeconds === "number" &&
                  completedAssistantMessage.reasoningDurationSeconds > 0) ||
                reasoningEverStartedRef.current ||
                reasoningSnapshot.length > 0
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
              shouldAutoScrollRef.current = true
              setIsStreaming(false)
              leadAnchorMessageIdRef.current = null
              const scrollNode = messagesScrollRef.current
              if (scrollNode) {
                setProgrammaticScrollTop(scrollNode, scrollNode.scrollHeight)
              }
              void refreshConversations().then(async () => {
                if (activeConversationIdRef.current === conversationId) {
                  await loadMessages(conversationId)
                  const node = messagesScrollRef.current
                  if (node) {
                    setProgrammaticScrollTop(node, node.scrollHeight)
                  }
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
      setProgrammaticScrollTop,
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
      if (conversationId === DRAFT_CONVERSATION_ID) {
        setHasDraftConversation(true)
        setDraftConversationUpdatedAt((prev) => prev || Date.now())
        setActiveConversationId(DRAFT_CONVERSATION_ID)
        setMessages([])
        return
      }
      setActiveConversationId(conversationId)
      await loadMessages(conversationId)
    },
    [isStreaming, loadMessages]
  )

  const handleNewConversation = useCallback(() => {
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
    if (activeConversationIdRef.current === DRAFT_CONVERSATION_ID) {
      setMessages([])
      return
    }
    setHasDraftConversation(true)
    setDraftConversationUpdatedAt(Date.now())
    setActiveConversationId(DRAFT_CONVERSATION_ID)
    setMessages([])
  }, [isStreaming])

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
      if (conversationId === DRAFT_CONVERSATION_ID) {
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
        setHasDraftConversation(false)
        setDraftConversationUpdatedAt(0)
        if (activeConversationIdRef.current === DRAFT_CONVERSATION_ID) {
          if (conversations.length === 0) {
            setActiveConversationId(null)
            setMessages([])
            return
          }
          const nextConversationId = conversations[0]?.id || null
          if (!nextConversationId) {
            setActiveConversationId(null)
            setMessages([])
            return
          }
          setActiveConversationId(nextConversationId)
          await loadMessages(nextConversationId)
        }
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
        setActiveConversationId(hasDraftConversation ? DRAFT_CONVERSATION_ID : null)
        setMessages([])
        return
      }

      const nextConversationId = list[0].id
      setActiveConversationId(nextConversationId)
      await loadMessages(nextConversationId)
    },
    [conversations, hasDraftConversation, isStreaming, loadMessages, refreshConversations, repository]
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
          disableConversationActions={isStreaming}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
        />
      </div>

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
            <div className="mx-auto max-w-5xl">
              {visibleMessages.map((message) => (
                <div key={message.id} data-message-id={message.id}>
                  <ChatMessage message={message} />
                </div>
              ))}
              {shouldShowThinkingWarmup ? (
                <TypingIndicator elapsedSeconds={streamingReasoningDurationSeconds} />
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
              isLoading={isStreaming}
              onHeightChange={(height) => {
                setChatInputHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height))
              }}
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
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <VoiceMode isOpen={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </main>
  )
}
