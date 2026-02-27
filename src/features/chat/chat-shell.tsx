import { useEffect, useMemo, useRef, useState } from "react"
import type { AppRuntime } from "../../app/contracts"
import type { ChatMessage } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"
import { LivekitSessionController } from "../../infrastructure/voice/livekit-session"
import { CHAT_MODELS } from "./models"
import "./chat-shell.css"

function newConversationId(): string {
  return `conv_${crypto.randomUUID()}`
}

function buildConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return "新对话"
  }
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  })
}

type VoiceState = "idle" | "connecting" | "connected" | "error"

export function ChatShell({ runtime }: { runtime: AppRuntime }) {
  const repository = runtime.services.repository
  const chatService = runtime.services.chat
  const voiceService = runtime.services.voice

  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [activeConversationId, setActiveConversationId] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [selectedModel, setSelectedModel] = useState(runtime.config.defaultModel)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingAssistantText, setStreamingAssistantText] = useState("")
  const [lastError, setLastError] = useState("")
  const [voiceState, setVoiceState] = useState<VoiceState>("idle")
  const [voiceSessionId, setVoiceSessionId] = useState("")

  const abortRef = useRef<AbortController | null>(null)
  const voiceControllerRef = useRef<LivekitSessionController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const activeConversationIdRef = useRef("")

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId),
    [conversations, activeConversationId]
  )

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  async function refreshConversations(): Promise<ConversationRecord[]> {
    const list = await repository.listConversations()
    setConversations(list)
    return list
  }

  async function loadMessages(conversationId: string): Promise<void> {
    const list = await chatService.listMessages(conversationId)
    setMessages(list)
  }

  async function createConversation(initialTitle = "新对话"): Promise<string> {
    const id = newConversationId()
    const now = Date.now()
    await repository.upsertConversation({
      id,
      title: initialTitle,
      anchors: {
        conversationId: id,
      },
      createdAt: now,
      updatedAt: now,
    })
    setActiveConversationId(id)
    await refreshConversations()
    await loadMessages(id)
    return id
  }

  async function ensureConversation(initialTitle = "新对话"): Promise<string> {
    if (activeConversationIdRef.current) {
      return activeConversationIdRef.current
    }
    return createConversation(initialTitle)
  }

  async function initialize(): Promise<void> {
    const list = await refreshConversations()
    if (list.length === 0) {
      await ensureConversation("新对话")
      return
    }
    const first = list[0]
    setActiveConversationId(first.id)
    await loadMessages(first.id)
  }

  useEffect(() => {
    void initialize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      const controller = voiceControllerRef.current
      voiceControllerRef.current = null
      if (controller) {
        void controller.disconnect()
      }
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingAssistantText, isStreaming])

  async function handleCreateConversation(): Promise<void> {
    if (isStreaming) {
      return
    }

    await createConversation("新对话")
    setStreamingAssistantText("")
    setLastError("")
  }

  async function handleSelectConversation(conversationId: string): Promise<void> {
    if (isStreaming || conversationId === activeConversationIdRef.current) {
      return
    }

    setActiveConversationId(conversationId)
    setStreamingAssistantText("")
    setLastError("")
    await loadMessages(conversationId)
  }

  async function handleSend(): Promise<void> {
    const text = input.trim()
    if (!text || isStreaming) {
      return
    }

    setLastError("")
    setInput("")
    setStreamingAssistantText("")
    setIsStreaming(true)

    const conversationId = await ensureConversation(buildConversationTitle(text))
    const current = conversations.find((item) => item.id === conversationId)
    const anchors =
      current?.anchors && Object.keys(current.anchors).length > 0 ? current.anchors : { conversationId }
    const optimisticMessage: ChatMessage = {
      id: `tmp_usr_${crypto.randomUUID()}`,
      role: "user",
      content: text,
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
          text,
          anchors,
        },
        (event) => {
          if (event.type === "delta") {
            setStreamingAssistantText((prev) => prev + event.textDelta)
            return
          }

          if (event.type === "completed") {
            setVoiceSessionId((prev) => event.result.anchors.sessionId || prev)
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
            setIsStreaming(false)
            setStreamingAssistantText("")
            setLastError(event.message)
            void refreshConversations().then(() => {
              if (activeConversationIdRef.current === conversationId) {
                return loadMessages(conversationId)
              }
            })
          }
        },
        controller.signal
      )
    } catch (error) {
      setIsStreaming(false)
      setStreamingAssistantText("")
      setLastError(error instanceof Error ? error.message : "chat_stream_error")
    } finally {
      abortRef.current = null
    }
  }

  function handleStopStreaming(): void {
    abortRef.current?.abort()
    setIsStreaming(false)
  }

  async function handleVoiceToggle(): Promise<void> {
    if (!runtime.config.voiceEnabled) {
      return
    }

    if (!voiceControllerRef.current) {
      voiceControllerRef.current = new LivekitSessionController(voiceService, {
        onConnected: (sessionId) => {
          setVoiceState("connected")
          setVoiceSessionId(sessionId)
        },
        onDisconnected: () => {
          setVoiceState("idle")
        },
        onError: (_sessionId, error) => {
          setVoiceState("error")
          setLastError(error)
        },
      })
    }

    const conversationId = await ensureConversation("语音会话")
    const current = conversations.find((item) => item.id === conversationId)

    try {
      if (voiceState === "connected") {
        await voiceControllerRef.current.disconnect()
        setVoiceState("idle")
        return
      }

      setVoiceState("connecting")
      await voiceControllerRef.current.connect({
        sessionId: current?.anchors.sessionId || voiceSessionId || undefined,
        conversationId: current?.anchors.conversationId || conversationId,
      })
    } catch (error) {
      setVoiceState("error")
      setLastError(error instanceof Error ? error.message : "voice_connect_error")
    }
  }

  return (
    <section className="chat-shell">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <h2 className="chat-title">会话</h2>
          <button className="chat-button" onClick={() => void handleCreateConversation()} disabled={isStreaming}>
            新建
          </button>
        </div>

        <div className="chat-conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`chat-conversation-item ${conversation.id === activeConversationId ? "active" : ""}`}
              onClick={() => void handleSelectConversation(conversation.id)}
              disabled={isStreaming}
            >
              <span className="chat-conversation-title">{conversation.title}</span>
              <span className="chat-conversation-meta">{formatTime(conversation.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-main-header">
          <select
            className="chat-model-select"
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            disabled={isStreaming}
          >
            {CHAT_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.provider})
              </option>
            ))}
          </select>

          <div className="chat-status-row">
            <span className="chat-status-pill">model: {selectedModel}</span>
            <span className="chat-status-pill">voice: {voiceState}</span>
            <span className="chat-status-pill">session: {voiceSessionId || "-"}</span>
          </div>
        </header>

        <div className="chat-message-scroll">
          {messages.length === 0 && !streamingAssistantText ? (
            <div className="chat-empty">开始一个新问题，我会通过 AI SDK 直连网关/Claude。</div>
          ) : (
            <div className="chat-message-list">
              {messages.map((message) => (
                <div key={message.id} className={`chat-bubble ${message.role === "user" ? "user" : "assistant"}`}>
                  {message.content}
                </div>
              ))}

              {streamingAssistantText ? (
                <div className="chat-bubble assistant streaming">{streamingAssistantText}</div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <footer className="chat-composer">
          {lastError ? <div className="chat-error">{lastError}</div> : null}
          <div className="chat-input-row">
            <textarea
              className="chat-input"
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void handleSend()
                }
              }}
              disabled={isStreaming}
            />
          </div>
          <div className="chat-input-row">
            <button className="chat-button" onClick={() => void handleSend()} disabled={isStreaming || !input.trim()}>
              {isStreaming ? "处理中..." : "发送"}
            </button>
            <button className="chat-secondary-button" onClick={handleStopStreaming} disabled={!isStreaming}>
              停止
            </button>
            <button
              className="chat-secondary-button"
              onClick={() => void handleVoiceToggle()}
              disabled={!runtime.config.voiceEnabled || voiceState === "connecting" || isStreaming}
            >
              {voiceState === "connected" ? "断开语音" : "连接语音"}
            </button>
          </div>
        </footer>
      </main>
    </section>
  )
}
