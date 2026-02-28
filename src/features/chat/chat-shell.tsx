import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AppRuntime } from "@/app/contracts"
import type { ChatMessage as DomainChatMessage } from "@/domain/chat/types"
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

export function ChatShell({ runtime }: { runtime: AppRuntime }) {
  const repository = runtime.services.repository
  const chatService = runtime.services.chat

  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DomainChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingAssistantText, setStreamingAssistantText] = useState("")
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
  const [chatInputHeight, setChatInputHeight] = useState(170)

  const abortRef = useRef<AbortController | null>(null)
  const activeConversationIdRef = useRef<string | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const wasThinkStreamingRef = useRef(false)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

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
      .map(toRenderMessage)
      .filter((item): item is RenderChatMessage => item !== null)

    if (streamingAssistantText.trim()) {
      rendered.push({
        id: "streaming_assistant",
        role: "assistant",
        content: streamingAssistantText,
      })
    }

    return rendered
  }, [messages, streamingAssistantText])

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
      abortRef.current?.abort()
    }
  }, [loadMessages, refreshConversations])

  useEffect(() => {
    const thinkStreaming = isStreaming && hasOpenThinkTag(streamingAssistantText)
    if (!shouldAutoScrollRef.current && !thinkStreaming) {
      wasThinkStreamingRef.current = false
      return
    }
    const node = messagesScrollRef.current
    if (!node) {
      wasThinkStreamingRef.current = thinkStreaming
      return
    }

    const enteringThinkStreaming = thinkStreaming && !wasThinkStreamingRef.current
    if (enteringThinkStreaming) {
      shouldAutoScrollRef.current = true
    }

    const dynamicOffset = Math.max(132, Math.round(chatInputHeight + 48))
    const thinkLeadSpace = Math.max(dynamicOffset + 240, Math.round(node.clientHeight * 0.6))
    const targetScrollTop = thinkStreaming
      ? Math.max(0, node.scrollHeight - node.clientHeight - thinkLeadSpace)
      : node.scrollHeight
    node.scrollTop = targetScrollTop
    wasThinkStreamingRef.current = thinkStreaming
  }, [chatInputHeight, isStreaming, streamingAssistantText, visibleMessages])

  const handleMessagesScroll = useCallback(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    const thinkStreaming = isStreaming && hasOpenThinkTag(streamingAssistantText)
    if (thinkStreaming) {
      // Keep autoscroll alive in think mode; we intentionally stay above bottom.
      shouldAutoScrollRef.current = true
      return
    }
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    shouldAutoScrollRef.current = distanceToBottom < 80
  }, [isStreaming, streamingAssistantText])

  const handleSendMessage = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim()
      if (!content || isStreaming) {
        return
      }

      setLastError("")
      setStreamingAssistantText("")
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
              setStreamingAssistantText((prev) => prev + event.textDelta)
              return
            }

            if (event.type === "completed") {
              setStreamingAssistantText("")
              setIsStreaming(false)
              void refreshConversations().then(() => {
                if (activeConversationIdRef.current === conversationId) {
                  return loadMessages(conversationId)
                }
              })
              return
            }

            if (event.type === "failed") {
              setStreamingAssistantText("")
              setIsStreaming(false)
              setLastError(event.message)
            }
          },
          controller.signal
        )
      } catch (error) {
        setStreamingAssistantText("")
        setIsStreaming(false)
        setLastError(error instanceof Error ? error.message : "chat_stream_error")
      } finally {
        abortRef.current = null
      }
    },
    [chatService, conversations, ensureConversation, isStreaming, loadMessages, refreshConversations, selectedModel]
  )

  const handleSelectConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (isStreaming || conversationId === activeConversationIdRef.current) {
        return
      }
      setLastError("")
      setStreamingAssistantText("")
      setActiveConversationId(conversationId)
      await loadMessages(conversationId)
    },
    [isStreaming, loadMessages]
  )

  const handleNewConversation = useCallback(async () => {
    if (isStreaming) {
      return
    }
    setLastError("")
    setStreamingAssistantText("")
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
                <ChatMessage key={message.id} message={message} />
              ))}
              {isStreaming && !streamingAssistantText ? <TypingIndicator /> : null}
              <div className={hasOpenThinkTag(streamingAssistantText) ? "h-10" : "h-4"} />
            </div>
          )}
        </div>

        <ChatInput
          onSendMessage={(text) => {
            void handleSendMessage(text)
          }}
          onVoiceStart={() => setVoiceOpen(true)}
          onHeightChange={(height) => {
            if (!Number.isFinite(height) || height <= 0) {
              return
            }
            setChatInputHeight(height)
          }}
          isLoading={isStreaming}
          onStop={() => {
            abortRef.current?.abort()
            setIsStreaming(false)
            setStreamingAssistantText("")
          }}
        />
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <VoiceMode isOpen={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </main>
  )
}
