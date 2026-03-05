import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AppFontSizeMode, AppRuntime, AppThemeMode } from "@/app/contracts"
import { applyAppearanceSettings } from "@/app/appearance"
import { applyAppearanceConfigToRuntime, applyGatewayConfigToRuntime } from "@/app/runtime"
import type {
  ChatAnchors,
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
import { buildConversationPdfFileName } from "./export-message-pdf"
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
import { resolveDeepSearchExpertModelId, resolveFastModelId } from "./model-selection"

function newConversationId(): string {
  return `conv_${crypto.randomUUID()}`
}

const DRAFT_CONVERSATION_ID = "draft_new_conversation"
const CHAT_INPUT_REVEAL_DELAY_MS = 500
const MODEL_SYNC_NOTICE_DURATION_MS = 2200
const PENDING_RETRY_FORCE_DETACH_AFTER_MS = 30_000

type ModelSyncNotice = {
  message: string
  tone: "success" | "error"
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
    createdAt: message.createdAt,
    research: message.research,
    responseId: message.responseId,
    previousResponseId: message.previousResponseId,
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

function resolveSendAnchors(
  conversationId: string,
  currentConversation: ConversationRecord | undefined,
  currentMessages: DomainChatMessage[]
): Partial<ChatAnchors> {
  const sessionId = (currentConversation?.anchors.sessionId || "").trim()
  let lastResponseId = (currentConversation?.anchors.lastResponseId || "").trim()
  if (!lastResponseId) {
    for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
      const candidate = currentMessages[index]
      if (candidate?.role !== "assistant") {
        continue
      }
      const responseId = (candidate.responseId || "").trim()
      if (responseId) {
        lastResponseId = responseId
        break
      }
    }
  }
  return {
    conversationId,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionId && lastResponseId ? { lastResponseId } : {}),
  }
}

function getLastPendingUserMessage(messages: DomainChatMessage[]): DomainChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) {
      continue
    }
    if (message.role === "assistant") {
      return null
    }
    if (message.role === "user") {
      return message
    }
  }
  return null
}

function parseRetryableUserMessageContent(content: string): {
  text: string
  hasAttachmentMarker: boolean
} {
  const textLines: string[] = []
  let hasAttachmentMarker = false
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[附件\]\s+.+$/.test(line)) {
      hasAttachmentMarker = true
      continue
    }
    textLines.push(line)
  }
  return {
    text: textLines.join("\n").trim(),
    hasAttachmentMarker,
  }
}

function buildReasoningCaches(list: DomainChatMessage[]): {
  reasoningByMessageId: Record<string, ChatReasoningEventDetail[]>
  reasoningDurationByMessageId: Record<string, number>
} {
  const reasoningByMessageId: Record<string, ChatReasoningEventDetail[]> = {}
  const reasoningDurationByMessageId: Record<string, number> = {}

  for (const message of list) {
    if (message.role !== "assistant") {
      continue
    }
    const messageId = message.id.trim()
    const responseId = message.responseId?.trim() || ""

    if (Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0) {
      reasoningByMessageId[messageId] = message.reasoningEvents
      if (responseId) {
        reasoningByMessageId[responseId] = message.reasoningEvents
      }
    }

    if (
      typeof message.reasoningDurationSeconds === "number" &&
      Number.isFinite(message.reasoningDurationSeconds) &&
      message.reasoningDurationSeconds > 0
    ) {
      const normalizedDuration = Math.max(1, Math.round(message.reasoningDurationSeconds))
      reasoningDurationByMessageId[messageId] = normalizedDuration
      if (responseId) {
        reasoningDurationByMessageId[responseId] = normalizedDuration
      }
    }
  }

  return {
    reasoningByMessageId,
    reasoningDurationByMessageId,
  }
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

function resolveReasoningDurationSeconds(
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

function normalizeConversationError(message: string): string {
  const text = message.trim()
  if (!text) {
    return ""
  }
  if (/stream_idle_timeout/i.test(text)) {
    return "连接超时，流式已中断，请重试。"
  }
  return text
}

function resolveStreamingConnectionHealth(
  isStreaming: boolean,
  lastHeartbeatAt: number | undefined,
  startedAt: number | undefined,
  now: number
): {
  level: "healthy" | "degraded" | "waiting"
  label: string
} | null {
  if (!isStreaming) {
    return null
  }
  const base = lastHeartbeatAt || startedAt || 0
  if (base <= 0) {
    return {
      level: "waiting",
      label: "连接中...",
    }
  }
  const idleMs = Math.max(0, now - base)
  if (idleMs <= 6000) {
    return {
      level: "healthy",
      label: "连接稳定",
    }
  }
  if (idleMs <= 12000) {
    return {
      level: "degraded",
      label: `连接波动 · ${Math.max(1, Math.round(idleMs / 1000))}s`,
    }
  }
  return {
    level: "waiting",
    label: `等待数据 · ${Math.max(1, Math.round(idleMs / 1000))}s`,
  }
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
  const [modelSyncNotice, setModelSyncNotice] = useState<ModelSyncNotice | null>(null)
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
  const [deepSearchEnabled, setDeepSearchEnabled] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)

  const abortControllerByConversationIdRef = useRef<Record<string, AbortController>>({})
  const activeConversationIdRef = useRef<string | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)
  const chatInputRevealTimerRef = useRef<number | null>(null)
  const modelSyncNoticeTimerRef = useRef<number | null>(null)
  const bottomLockRef = useRef(false)
  const attemptedPendingRecoveryMessageIdByConversationRef = useRef<Record<string, string>>({})

  const clearModelSyncNoticeTimer = useCallback(() => {
    if (modelSyncNoticeTimerRef.current !== null) {
      window.clearTimeout(modelSyncNoticeTimerRef.current)
      modelSyncNoticeTimerRef.current = null
    }
  }, [])

  const showModelSyncNotice = useCallback(
    (message: string, tone: "success" | "error") => {
      clearModelSyncNoticeTimer()
      setModelSyncNotice({ message, tone })
      modelSyncNoticeTimerRef.current = window.setTimeout(() => {
        setModelSyncNotice(null)
        modelSyncNoticeTimerRef.current = null
      }, MODEL_SYNC_NOTICE_DURATION_MS)
    },
    [clearModelSyncNoticeTimer]
  )

  useEffect(() => {
    return () => {
      clearModelSyncNoticeTimer()
    }
  }, [clearModelSyncNoticeTimer])

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
  const activeVisibleError = useMemo(() => {
    return normalizeConversationError(activeLastError)
  }, [activeLastError])
  const activePendingUserMessage = useMemo(() => {
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return null
    }
    if (isConversationStreaming(streamingStateByConversationId, activeConversationId)) {
      return null
    }
    return getLastPendingUserMessage(activeMessages)
  }, [activeConversationId, activeMessages, streamingStateByConversationId])

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
        hasDeepSearch: item.hasDeepSearch,
        updatedAt: new Date(item.updatedAt),
      }))
      if (hasDraftConversation) {
        mapped.unshift({
          id: DRAFT_CONVERSATION_ID,
          title: "",
          hasDeepSearch: false,
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
          research: message.research,
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
  const assistantRoundByMessageId = useMemo(() => {
    const map: Record<string, number> = {}
    let round = 0
    for (const message of visibleMessages) {
      if (message.role !== "assistant" || message.id === "streaming_assistant") {
        continue
      }
      round += 1
      map[message.id] = round
    }
    return map
  }, [visibleMessages])
  const latestAssistantMessageId = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index]
      if (message.role !== "assistant" || message.id === "streaming_assistant") {
        continue
      }
      return message.id
    }
    return ""
  }, [visibleMessages])
  const pdfExportMetaByMessageId = useMemo(() => {
    const map: Record<string, { title: string; round: number; fileName: string }> = {}
    for (const [messageId, round] of Object.entries(assistantRoundByMessageId)) {
      map[messageId] = {
        title: activeConversationTitle,
        round,
        fileName: buildConversationPdfFileName(activeConversationTitle, round),
      }
    }
    return map
  }, [activeConversationTitle, assistantRoundByMessageId])
  const activeConnectionHealth = useMemo(() => {
    return resolveStreamingConnectionHealth(
      isActiveConversationStreaming,
      activeStreamingState?.lastHeartbeatAt,
      activeStreamingState?.startedAt,
      Date.now()
    )
  }, [
    isActiveConversationStreaming,
    activeStreamingReasoningDurationSeconds,
    activeStreamingState?.lastHeartbeatAt,
    activeStreamingState?.startedAt,
  ])
  const shouldShowRetryPendingButton = Boolean(activePendingUserMessage && !isActiveConversationStreaming)
  const shouldShowHeaderNewConversationButton = conversations.length > 0

  const resetComposerForNewConversation = useCallback(() => {
    const fastModelId = resolveFastModelId(modelOptions, selectedModel)
    if (fastModelId && fastModelId !== selectedModel) {
      setSelectedModel(fastModelId)
    }
    setDeepSearchEnabled(false)
  }, [modelOptions, selectedModel])

  const handleDeepSearchEnabledChange = useCallback(
    (enabled: boolean) => {
      setDeepSearchEnabled(enabled)
      if (!enabled) {
        return
      }
      const expertModelId = resolveDeepSearchExpertModelId(modelOptions, selectedModel)
      if (expertModelId && expertModelId !== selectedModel) {
        setSelectedModel(expertModelId)
      }
    },
    [modelOptions, selectedModel]
  )

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
    const comfortBuffer = Math.round(effectiveInputHeight * 0.62 + 14)
    return Math.max(base, Math.min(comfortBuffer, 164))
  }, [chatInputHeight, isThinkingStreaming])

  const refreshModelOptions = useCallback(
    async (silent = false): Promise<void> => {
      setIsRefreshingModels(true)
      try {
        const remoteModels = await fetchRemoteModelOptions(runtime.config)
        setModelOptions(remoteModels)
        persistModelOptions(remoteModels)
        setSelectedModel((current) =>
          resolveSelectedModel(remoteModels, [current, readStoredSelectedModel(), runtime.config.defaultModel])
        )
        if (!silent) {
          showModelSyncNotice("已同步", "success")
        }
      } catch {
        if (!silent) {
          showModelSyncNotice("同步失败，请重试", "error")
        }
      } finally {
        setIsRefreshingModels(false)
      }
    },
    [runtime.config, showModelSyncNotice]
  )

  useEffect(() => {
    void refreshModelOptions(true)
  }, [refreshModelOptions])

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
      const caches = buildReasoningCaches(list)
      setPersistedReasoningForConversation(conversationId, caches.reasoningByMessageId)
      setPersistedReasoningDurationForConversation(conversationId, caches.reasoningDurationByMessageId)
    },
    [chatService, setMessagesForConversation, setPersistedReasoningDurationForConversation, setPersistedReasoningForConversation]
  )

  const attemptRecoverPendingAssistant = useCallback(
    async (
      conversationId: string,
      messages: DomainChatMessage[]
    ): Promise<"recovered" | "in_progress" | "none"> => {
      if (conversationId === DRAFT_CONVERSATION_ID) {
        return "none"
      }
      const pendingUserMessage = getLastPendingUserMessage(messages)
      if (!pendingUserMessage) {
        return "none"
      }
      const conversation = conversations.find((item) => item.id === conversationId)
      const anchors = resolveSendAnchors(conversationId, conversation, messages)
      const recovery = await chatService.recoverPendingAssistant({
        conversationId,
        anchors,
      })
      if (!recovery.recovered) {
        if (recovery.inProgress) {
          setLastErrorForConversation(conversationId, "上一轮仍在处理中，请稍后点击重试。")
          return "in_progress"
        }
        return "none"
      }
      clearLastErrorForConversation(conversationId)
      attemptedPendingRecoveryMessageIdByConversationRef.current[conversationId] = ""
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
        hasDeepSearch: false,
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
    if (!activeConversationId || activeConversationId === DRAFT_CONVERSATION_ID) {
      return
    }
    if (isConversationStreaming(streamingStateByConversationId, activeConversationId)) {
      return
    }
    const pendingUserMessage = getLastPendingUserMessage(activeMessages)
    if (!pendingUserMessage) {
      attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = ""
      return
    }
    const attemptedMessageId =
      attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] || ""
    if (attemptedMessageId === pendingUserMessage.id) {
      return
    }
    attemptedPendingRecoveryMessageIdByConversationRef.current[activeConversationId] = pendingUserMessage.id
    void attemptRecoverPendingAssistant(activeConversationId, activeMessages)
  }, [
    activeConversationId,
    activeMessages,
    attemptRecoverPendingAssistant,
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
    async (
      text: string,
      attachments?: File[],
      options?: {
        deepSearch?: boolean
        retryExistingUserMessageId?: string
        forceDetachedRetry?: boolean
      }
    ): Promise<void> => {
      const content = text.trim()
      const selectedAttachments = Array.isArray(attachments)
        ? attachments.filter((file) => Boolean(file))
        : []
      const retryExistingUserMessageId = options?.retryExistingUserMessageId?.trim() || ""
      const forceDetachedRetry = retryExistingUserMessageId ? options?.forceDetachedRetry === true : false
      const deepSearch = retryExistingUserMessageId ? false : options?.deepSearch === true
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
      const currentMessages = messagesByConversationId[conversationId] || []
      const resolvedAnchors = resolveSendAnchors(conversationId, current, currentMessages)
      const anchors: Partial<ChatAnchors> = forceDetachedRetry
        ? {
            conversationId,
            ...(resolvedAnchors.lastResponseId ? { lastResponseId: resolvedAnchors.lastResponseId } : {}),
          }
        : resolvedAnchors
      const clientTurnId = `turn_${crypto.randomUUID()}`

      const optimisticMessage: DomainChatMessage | null = retryExistingUserMessageId
        ? null
        : {
            id: `tmp_usr_${crypto.randomUUID()}`,
            role: "user",
            content: optimisticContent,
            createdAt: Date.now(),
            status: "completed",
          }
      shouldAutoScrollRef.current = activeConversationIdRef.current === conversationId
      if (optimisticMessage) {
        appendMessageForConversation(conversationId, optimisticMessage)
      }

      const startedAt = Date.now()
      let assistantText = ""
      let reasoningEvents: ChatReasoningEventDetail[] = []
      let reasoningActive = false
      let assistantOutputStarted = false
      let reasoningEverStarted = false
      let reasoningStartedAtMs: number | null = null
      let reasoningEndedAtMs: number | null = null
      let reasoningStopTimer: number | null = null
      let pendingCardAttachmentDetails: ChatReasoningEventDetail[] = []
      let cardAttachmentFlushTimer: number | null = null

      setStreamingStateForConversation(conversationId, {
        assistantText: "",
        reasoningEvents: [],
        reasoningActive: false,
        reasoningDurationSeconds: 0,
        startedAt,
        lastHeartbeatAt: startedAt,
        leadAnchorMessageId: retryExistingUserMessageId || optimisticMessage?.id || null,
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

      const markReasoningStarted = () => {
        const now = Date.now()
        if (!reasoningStartedAtMs) {
          reasoningStartedAtMs = now
        }
        reasoningEndedAtMs = null
      }

      const markReasoningEnded = () => {
        if (reasoningStartedAtMs && !reasoningEndedAtMs) {
          reasoningEndedAtMs = Date.now()
        }
      }

      const durationTimer = window.setInterval(() => {
        const nextDuration = resolveReasoningDurationSeconds(reasoningStartedAtMs, reasoningEndedAtMs)
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
      const resetDeepSearchAfterTurn = () => {
        if (deepSearch) {
          setDeepSearchEnabled(false)
        }
      }

      try {
        await chatService.streamTurn(
          {
            model: selectedModel,
            text: content,
            attachments: selectedAttachments,
            anchors,
            clientTurnId,
            deepSearch,
            retryExistingUserMessage: Boolean(retryExistingUserMessageId),
          },
          (event) => {
            if (event.type === "heartbeat") {
              patchStreamingStateForConversation(conversationId, {
                lastHeartbeatAt: event.meta.ts,
              })
              return
            }

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
                markReasoningEnded()
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
                markReasoningStarted()
              } else if (assistantOutputStarted) {
                clearReasoningStopTimer()
                // Keep timeline collapsed after answer text starts.
                reasoningActive = false
                markReasoningEnded()
              } else if (reasoningEverStarted && !assistantText.trim()) {
                clearReasoningStopTimer()
                // Sticky thinking UX: avoid pre-answer flicker when reasoning has transient gaps.
                reasoningActive = true
                markReasoningStarted()
              } else if (reasoningStopTimer === null) {
                reasoningStopTimer = window.setTimeout(() => {
                  reasoningActive = false
                  reasoningStopTimer = null
                  markReasoningEnded()
                  syncStreamingState()
                }, 700)
              }
              syncStreamingState()
              return
            }

            if (event.type === "completed") {
              flushPendingCardAttachments(false)
              clearReasoningStopTimer()
              markReasoningEnded()
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
                    hasDeepSearch: Boolean(currentConversation.hasDeepSearch || deepSearch),
                    updatedAt: now,
                  }
                  return next
                }
                return [
                  {
                    id: conversationId,
                    title: "",
                    anchors: event.result.anchors,
                    hasDeepSearch: deepSearch,
                    createdAt: now,
                    updatedAt: now,
                  },
                  ...previous,
                ]
              })
              const completedAssistantMessage = event.result.assistantMessage
              const reasoningSnapshot = completedAssistantMessage.reasoningEvents || reasoningEvents
              const computedDurationSeconds = resolveReasoningDurationSeconds(reasoningStartedAtMs, reasoningEndedAtMs)
              const upstreamDurationSeconds =
                typeof completedAssistantMessage.reasoningDurationSeconds === "number" &&
                completedAssistantMessage.reasoningDurationSeconds > 0
                  ? Math.max(1, Math.round(completedAssistantMessage.reasoningDurationSeconds))
                  : 0
              const finalDurationSeconds = computedDurationSeconds || upstreamDurationSeconds
              const shouldPersistReasoningDuration =
                finalDurationSeconds > 0 ||
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
                    Math.max(1, finalDurationSeconds || 1)
                  )
                }
              } else if (shouldPersistReasoningDuration) {
                const messageId = event.result.assistantMessage.id.trim()
                const responseId = event.result.assistantMessage.responseId?.trim() || ""
                upsertPersistedReasoningDurationEntry(
                  conversationId,
                  messageId,
                  responseId,
                  Math.max(1, finalDurationSeconds || 1)
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
              resetDeepSearchAfterTurn()
              return
            }

            if (event.type === "failed") {
              clearCardAttachmentFlushTimer()
              pendingCardAttachmentDetails = []
              clearStreamingState()
              if (event.code === "turn_in_progress") {
                setLastErrorForConversation(conversationId, "上一轮仍在处理中，请稍后点击重试。")
              } else {
                setLastErrorForConversation(conversationId, event.message)
              }
              resetDeepSearchAfterTurn()
            }
          },
          controller.signal
        )
      } catch (error) {
        const wasAborted = controller.signal.aborted
        clearStreamingState()
        if (wasAborted) {
          setLastErrorForConversation(conversationId, "已终止，可重试。")
          resetDeepSearchAfterTurn()
          return
        }
        setLastErrorForConversation(conversationId, error instanceof Error ? error.message : "chat_stream_error")
        resetDeepSearchAfterTurn()
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
      refreshConversations,
      selectedModel,
      streamingStateByConversationId,
      upsertPersistedReasoningDurationEntry,
      upsertPersistedReasoningEntry,
    ]
  )

  const handleRetryPendingTurn = useCallback(async (): Promise<void> => {
    const conversationId = activeConversationIdRef.current
    if (!conversationId || conversationId === DRAFT_CONVERSATION_ID) {
      return
    }
    if (isConversationStreaming(streamingStateByConversationId, conversationId)) {
      return
    }

    const currentMessages = messagesByConversationId[conversationId] || []
    const pendingUserMessage = getLastPendingUserMessage(currentMessages)
    if (!pendingUserMessage) {
      return
    }

    clearLastErrorForConversation(conversationId)
    const recoveryStatus = await attemptRecoverPendingAssistant(conversationId, currentMessages)
    if (recoveryStatus === "recovered") {
      return
    }
    const retryPayload = parseRetryableUserMessageContent(pendingUserMessage.content)
    if (!retryPayload.text) {
      setLastErrorForConversation(conversationId, "重试失败：缺少可发送文本。")
      return
    }
    if (retryPayload.hasAttachmentMarker) {
      setLastErrorForConversation(conversationId, "该问题包含附件，请重新上传后发送。")
      return
    }

    if (recoveryStatus === "in_progress") {
      const pendingAgeMs = Math.max(0, Date.now() - pendingUserMessage.createdAt)
      if (pendingAgeMs < PENDING_RETRY_FORCE_DETACH_AFTER_MS) {
        return
      }
    }

    await handleSendMessage(retryPayload.text, [], {
      retryExistingUserMessageId: pendingUserMessage.id,
      ...(recoveryStatus === "in_progress" ? { forceDetachedRetry: true } : {}),
    })
  }, [
    attemptRecoverPendingAssistant,
    clearLastErrorForConversation,
    handleSendMessage,
    messagesByConversationId,
    setLastErrorForConversation,
    streamingStateByConversationId,
  ])

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
      const targetResponseId = (targetAssistant.responseId || targetAssistant.id || "").trim()
      if (!targetResponseId) {
        setLastErrorForConversation(conversationId, "重试失败：缺少目标回复 ID")
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

      const parentResponseId = (() => {
        const direct = targetAssistant.previousResponseId?.trim()
        if (direct) {
          return direct
        }
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
          const item = currentMessages[index]
          if (!item || item.role !== "assistant") {
            continue
          }
          const responseId = (item.responseId || item.id || "").trim()
          if (responseId) {
            return responseId
          }
        }
        return ""
      })()

      const leadAnchorMessageId = currentMessages[previousUserIndex]?.id || null
      const currentConversation =
        conversations.find((item) => item.id === conversationId) || null
      const sessionId =
        currentConversation?.anchors.sessionId?.trim() ||
        `sess_${conversationId}`
      const clientTurnId = `turn_${crypto.randomUUID()}`

      clearLastErrorForConversation(conversationId)

      const startedAt = Date.now()
      let assistantText = ""
      let reasoningEvents: ChatReasoningEventDetail[] = []
      let reasoningActive = false
      let assistantOutputStarted = false
      let reasoningEverStarted = false
      let reasoningStartedAtMs: number | null = null
      let reasoningEndedAtMs: number | null = null
      let reasoningStopTimer: number | null = null
      let pendingCardAttachmentDetails: ChatReasoningEventDetail[] = []
      let cardAttachmentFlushTimer: number | null = null

      setStreamingStateForConversation(conversationId, {
        assistantText: "",
        reasoningEvents: [],
        reasoningActive: false,
        reasoningDurationSeconds: 0,
        startedAt,
        lastHeartbeatAt: startedAt,
        leadAnchorMessageId,
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

      const markReasoningStarted = () => {
        const now = Date.now()
        if (!reasoningStartedAtMs) {
          reasoningStartedAtMs = now
        }
        reasoningEndedAtMs = null
      }

      const markReasoningEnded = () => {
        if (reasoningStartedAtMs && !reasoningEndedAtMs) {
          reasoningEndedAtMs = Date.now()
        }
      }

      const durationTimer = window.setInterval(() => {
        const nextDuration = resolveReasoningDurationSeconds(reasoningStartedAtMs, reasoningEndedAtMs)
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
              patchStreamingStateForConversation(conversationId, {
                lastHeartbeatAt: event.meta.ts,
              })
              return
            }

            if (event.type === "delta") {
              const nextText = `${assistantText}${event.textDelta}`
              assistantText = nextText
              const hasVisibleDelta = event.textDelta.trim().length > 0
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
                reasoningStopTimer = window.setTimeout(() => {
                  reasoningActive = false
                  reasoningStopTimer = null
                  markReasoningEnded()
                  syncStreamingState()
                }, 700)
              }
              syncStreamingState()
              return
            }

            if (event.type === "completed") {
              flushPendingCardAttachments(false)
              clearReasoningStopTimer()
              markReasoningEnded()
              const completedAssistantMessage = event.result.assistantMessage
              const reasoningSnapshot = completedAssistantMessage.reasoningEvents || reasoningEvents
              const computedDurationSeconds = resolveReasoningDurationSeconds(reasoningStartedAtMs, reasoningEndedAtMs)
              const upstreamDurationSeconds =
                typeof completedAssistantMessage.reasoningDurationSeconds === "number" &&
                completedAssistantMessage.reasoningDurationSeconds > 0
                  ? Math.max(1, Math.round(completedAssistantMessage.reasoningDurationSeconds))
                  : 0
              const finalDurationSeconds = computedDurationSeconds || upstreamDurationSeconds
              const shouldPersistReasoningDuration =
                finalDurationSeconds > 0 ||
                reasoningEverStarted ||
                reasoningSnapshot.length > 0
              if (reasoningSnapshot.length > 0) {
                const messageId = completedAssistantMessage.id.trim()
                const responseId = completedAssistantMessage.responseId?.trim() || ""
                upsertPersistedReasoningEntry(conversationId, messageId, responseId, reasoningSnapshot)
                if (shouldPersistReasoningDuration) {
                  upsertPersistedReasoningDurationEntry(
                    conversationId,
                    messageId,
                    responseId,
                    Math.max(1, finalDurationSeconds || 1)
                  )
                }
              } else if (shouldPersistReasoningDuration) {
                const messageId = completedAssistantMessage.id.trim()
                const responseId = completedAssistantMessage.responseId?.trim() || ""
                upsertPersistedReasoningDurationEntry(
                  conversationId,
                  messageId,
                  responseId,
                  Math.max(1, finalDurationSeconds || 1)
                )
              }
              shouldAutoScrollRef.current = true
              clearStreamingState()
              void (async () => {
                try {
                  // Confirm-then-commit: only cut old branch after upstream regenerate completes.
                  await repository.truncateMessagesAfter(conversationId, targetAssistant.id, true)
                  await repository.appendMessage(conversationId, completedAssistantMessage)
                  const now = Date.now()
                  const latestConversations = await repository.listConversations()
                  const latestConversation =
                    latestConversations.find((item) => item.id === conversationId) || currentConversation
                  await repository.upsertConversation({
                    id: conversationId,
                    title: latestConversation?.title || currentConversation?.title || "",
                    anchors: event.result.anchors,
                    hasDeepSearch:
                      latestConversation?.hasDeepSearch || currentConversation?.hasDeepSearch || false,
                    createdAt: latestConversation?.createdAt || currentConversation?.createdAt || now,
                    updatedAt: now,
                  })
                } catch (error) {
                  const message = error instanceof Error ? error.message : "重生成提交失败"
                  setLastErrorForConversation(conversationId, message)
                }
              })()
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
              if (event.code === "turn_in_progress") {
                setLastErrorForConversation(conversationId, "上一轮仍在处理中，请稍后点击重试。")
              } else {
                setLastErrorForConversation(conversationId, event.message)
              }
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
              setDeepSearchEnabled(false)
            }}
            onRefresh={() => {
              void refreshModelOptions()
            }}
            isRefreshing={isRefreshingModels}
            refreshStatusMessage={modelSyncNotice?.message}
            refreshStatusTone={modelSyncNotice?.tone}
          />
          <div className="flex min-w-0 items-center gap-2">
            {activeConnectionHealth || activeVisibleError || shouldShowRetryPendingButton ? (
              <div className="flex min-w-0 items-center gap-2">
                {activeConnectionHealth ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px]",
                      activeConnectionHealth.level === "healthy"
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : activeConnectionHealth.level === "degraded"
                          ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          : "border-border bg-muted text-muted-foreground"
                    )}
                  >
                    {activeConnectionHealth.label}
                  </span>
                ) : null}
                {activeVisibleError ? (
                  <span className="truncate text-xs text-destructive">
                    {activeVisibleError}
                  </span>
                ) : null}
                {shouldShowRetryPendingButton ? (
                  <button
                    type="button"
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border border-border bg-secondary px-3 py-1 text-xs text-foreground transition-colors",
                      "hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                    onClick={() => {
                      void handleRetryPendingTurn()
                    }}
                  >
                    重试
                  </button>
                ) : null}
              </div>
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
              onSendMessage={(text, attachments, options) => {
                void handleSendMessage(text, attachments, options)
              }}
              onVoiceStart={() => setVoiceOpen(true)}
              isLoading={isActiveConversationStreaming}
              deepSearchEnabled={deepSearchEnabled}
              onDeepSearchChange={handleDeepSearchEnabledChange}
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

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        runtime={runtime}
        onGatewayConfigChange={handleGatewayConfigChange}
        onAppearanceConfigChange={handleAppearanceConfigChange}
      />
      <VoiceMode isOpen={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </main>
  )
}
