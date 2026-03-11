"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import type { VoiceService, VoiceTextEvent } from "@/domain/voice/service"
import { Button } from "@/components/ui/button"
import {
  ArrowUp,
  ChevronDown,
  File as FileIcon,
  Mic,
  MicOff,
  Paperclip,
  Settings2,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import {
  DEFAULT_VOICE_OPTION_ID,
  DEFAULT_VOICE_PERSONALITY_ID,
  VoiceSettingsSheet,
  getVoiceOptionLabel,
  type VoiceOptionId,
  type VoicePersonalityId,
} from "@/components/voice-settings-sheet"
import {
  getVoiceEntryAriaLabel,
  getVoiceEntryBarHeights,
  type VoiceEntryState,
} from "@/components/chat-input-voice-entry"
import { resolveVoicePersonalityPayload } from "@/components/voice-settings-personality"
import {
  LivekitSessionController,
  type LivekitSessionSnapshot,
} from "@/infrastructure/voice/livekit-session"
import { cn } from "@/lib/utils"

function AudioWaveIcon({ state = "idle" }: { state?: VoiceEntryState }) {
  const heights = getVoiceEntryBarHeights(state)

  return (
    <div aria-hidden="true" className="relative flex items-center justify-center gap-0.5 text-current">
      {heights.map((height, index) => (
        <div
          key={`${height}-${index}`}
          className="relative z-10 w-0.5 rounded-full bg-current transition-[height,color] duration-200 ease-out"
          style={{ height }}
        />
      ))}
    </div>
  )
}

function VoiceLevelIndicator({ active }: { active: boolean }) {
  const heights = active ? [0.34, 0.41, 0.45, 0.31, 0.22] : [0.18, 0.2, 0.18, 0.16, 0.14]

  return (
    <div aria-hidden="true" className="hidden min-[360px]:flex items-end gap-0.5">
      {heights.map((height, index) => (
        <div
          key={`${height}-${index}`}
          className={cn(
            "w-0.5 rounded-full transition-[height,opacity] duration-300",
            active ? "bg-blue-300 opacity-100 animate-pulse" : "bg-muted-foreground/45 opacity-70"
          )}
          style={{
            height: `${height}rem`,
            animationDelay: `${index * 120}ms`,
          }}
        />
      ))}
    </div>
  )
}

interface ChatInputProps {
  onSendMessage: (text: string, attachments?: File[]) => void
  isLoading: boolean
  onStop?: () => void
  onHeightChange?: (height: number) => void
  voiceEnabled?: boolean
  activeConversationId?: string | null
  voiceService?: VoiceService
  onPrepareVoiceSession?: () => Promise<{
    conversationId: string
    sessionId?: string
  }>
  onVoiceRuntimeEvent?: (event: ChatInputVoiceRuntimeEvent) => void | Promise<void>
}

export type ChatInputVoiceRuntimeEvent =
  | {
      type: "issued"
      conversationId: string
      snapshot: LivekitSessionSnapshot
    }
  | {
      type: "connected"
      conversationId: string
      snapshot: LivekitSessionSnapshot
    }
  | {
      type: "disconnected"
      conversationId: string
      snapshot: LivekitSessionSnapshot
    }
  | {
      type: "error"
      conversationId: string
      snapshot: LivekitSessionSnapshot
      error: string
    }
  | {
      type: "text"
      conversationId: string
      snapshot: LivekitSessionSnapshot
      event: VoiceTextEvent
    }

export function ChatInput({
  onSendMessage,
  isLoading,
  onStop,
  onHeightChange,
  voiceEnabled = true,
  activeConversationId,
  voiceService,
  onPrepareVoiceSession,
  onVoiceRuntimeEvent,
}: ChatInputProps) {
  const [input, setInput] = useState("")
  const [isRecording, setIsRecording] = useState(false)
  const [voiceEntryState, setVoiceEntryState] = useState<VoiceEntryState>("idle")
  const [isVoiceMicMuted, setIsVoiceMicMuted] = useState(false)
  const [isVoiceSpeakerMuted, setIsVoiceSpeakerMuted] = useState(false)
  const [isVoiceSettingsOpen, setIsVoiceSettingsOpen] = useState(false)
  const [selectedVoiceId, setSelectedVoiceId] = useState<VoiceOptionId>(DEFAULT_VOICE_OPTION_ID)
  const [selectedVoicePersonalityId, setSelectedVoicePersonalityId] = useState<VoicePersonalityId>(DEFAULT_VOICE_PERSONALITY_ID)
  const [savedVoicePrompt, setSavedVoicePrompt] = useState("")
  const [voiceSpeed, setVoiceSpeed] = useState(1)
  const [attachments, setAttachments] = useState<File[]>([])
  const [imagePreviewUrlByIndex, setImagePreviewUrlByIndex] = useState<Record<number, string>>({})
  const [loadedPreviewByIndex, setLoadedPreviewByIndex] = useState<Record<number, true>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const voiceConnectTimeoutRef = useRef<number | null>(null)
  const voiceControllerRef = useRef<LivekitSessionController | null>(null)
  const voiceConversationIdRef = useRef("")
  const onVoiceRuntimeEventRef = useRef(onVoiceRuntimeEvent)
  const pendingManualVoiceTextRef = useRef("")
  const isVoiceMode = voiceEntryState === "active"
  const isVoiceConnecting = voiceEntryState === "connecting"

  const clearVoiceConnectTimeout = useCallback(() => {
    if (voiceConnectTimeoutRef.current === null) {
      return
    }
    window.clearTimeout(voiceConnectTimeoutRef.current)
    voiceConnectTimeoutRef.current = null
  }, [])

  const emitVoiceRuntimeEvent = useCallback((event: ChatInputVoiceRuntimeEvent) => {
    void onVoiceRuntimeEventRef.current?.(event)
  }, [])

  const resetVoiceUiState = useCallback(() => {
    clearVoiceConnectTimeout()
    setVoiceEntryState("idle")
    setIsVoiceMicMuted(false)
    setIsVoiceSpeakerMuted(false)
    setIsVoiceSettingsOpen(false)
    pendingManualVoiceTextRef.current = ""
    voiceConversationIdRef.current = ""
  }, [clearVoiceConnectTimeout])

  const getVoiceController = useCallback(() => {
    if (!voiceService) {
      return null
    }
    if (voiceControllerRef.current) {
      return voiceControllerRef.current
    }
    voiceControllerRef.current = new LivekitSessionController(voiceService, {
      onIssued: (snapshot) => {
        const conversationId = voiceConversationIdRef.current
        if (!conversationId) {
          return
        }
        emitVoiceRuntimeEvent({
          type: "issued",
          conversationId,
          snapshot,
        })
      },
      onConnected: (snapshot) => {
        const conversationId = voiceConversationIdRef.current
        if (!conversationId) {
          return
        }
        setVoiceEntryState("active")
        setIsVoiceMicMuted(snapshot.micMuted)
        setIsVoiceSpeakerMuted(snapshot.speakerMuted)
        emitVoiceRuntimeEvent({
          type: "connected",
          conversationId,
          snapshot,
        })
      },
      onDisconnected: (snapshot) => {
        const conversationId = voiceConversationIdRef.current
        resetVoiceUiState()
        if (!conversationId) {
          return
        }
        emitVoiceRuntimeEvent({
          type: "disconnected",
          conversationId,
          snapshot,
        })
      },
      onError: (snapshot, error) => {
        const conversationId = voiceConversationIdRef.current
        resetVoiceUiState()
        if (!conversationId) {
          return
        }
        emitVoiceRuntimeEvent({
          type: "error",
          conversationId,
          snapshot,
          error,
        })
      },
      onTextEvent: (snapshot, event) => {
        const conversationId = voiceConversationIdRef.current
        if (event.role === "user") {
          const pendingManualText = pendingManualVoiceTextRef.current.trim()
          if (!pendingManualText || pendingManualText !== event.text.trim()) {
            setInput(event.text)
            if (textareaRef.current) {
              textareaRef.current.style.height = "auto"
              textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
            }
          }
          if (event.final && pendingManualText === event.text.trim()) {
            pendingManualVoiceTextRef.current = ""
          }
        }
        if (!conversationId) {
          return
        }
        emitVoiceRuntimeEvent({
          type: "text",
          conversationId,
          snapshot,
          event,
        })
      },
    })
    return voiceControllerRef.current
  }, [emitVoiceRuntimeEvent, resetVoiceUiState, voiceService])

  const disconnectVoiceController = useCallback(
    async (endReason = "manual_close") => {
      clearVoiceConnectTimeout()
      const controller = voiceControllerRef.current
      if (!controller) {
        resetVoiceUiState()
        return
      }
      await controller.disconnect(endReason)
      resetVoiceUiState()
    },
    [clearVoiceConnectTimeout, resetVoiceUiState]
  )

  const isImageAttachment = (file: File): boolean => {
    const mimeType = (file.type || "").toLowerCase()
    if (mimeType.startsWith("image/")) {
      return true
    }
    return /\.(?:png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name)
  }

  const imageAttachments = useMemo(
    () =>
      attachments
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => isImageAttachment(file)),
    [attachments]
  )

  const selectedVoiceLabel = getVoiceOptionLabel(selectedVoiceId)
  const resolvedVoiceSettings = useMemo(() => {
    const personalityPayload = resolveVoicePersonalityPayload(selectedVoicePersonalityId, savedVoicePrompt)
    return {
      voice: selectedVoiceId,
      speed: voiceSpeed,
      ...personalityPayload,
    }
  }, [savedVoicePrompt, selectedVoiceId, selectedVoicePersonalityId, voiceSpeed])

  const fileAttachments = useMemo(
    () =>
      attachments
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => !isImageAttachment(file)),
    [attachments]
  )

  useEffect(() => {
    onVoiceRuntimeEventRef.current = onVoiceRuntimeEvent
  }, [onVoiceRuntimeEvent])

  useEffect(() => {
    return () => {
      clearVoiceConnectTimeout()
    }
  }, [clearVoiceConnectTimeout])

  useEffect(() => {
    if (voiceEnabled) {
      return
    }
    void disconnectVoiceController("manual_close")
  }, [disconnectVoiceController, voiceEnabled])

  useEffect(() => {
    if (!isVoiceMode || !textareaRef.current) {
      return
    }

    const element = textareaRef.current
    const focusInput = () => {
      element.focus()
      const end = element.value.length
      element.setSelectionRange(end, end)
    }

    focusInput()
    const frame = window.requestAnimationFrame(focusInput)
    return () => window.cancelAnimationFrame(frame)
  }, [isVoiceMode])

  useEffect(() => {
    const activeId = activeConversationId?.trim() || ""
    const voiceConversationId = voiceConversationIdRef.current
    if (!voiceConversationId || !voiceControllerRef.current) {
      return
    }
    if (activeId && activeId === voiceConversationId) {
      return
    }
    void disconnectVoiceController("manual_close")
  }, [activeConversationId, disconnectVoiceController])

  useEffect(() => {
    return () => {
      void disconnectVoiceController("manual_close")
    }
  }, [disconnectVoiceController])

  useEffect(() => {
    if (!onHeightChange || !containerRef.current) {
      return
    }
    const element = containerRef.current
    const notifyHeight = () => {
      onHeightChange(element.getBoundingClientRect().height)
    }
    notifyHeight()
    const observer = new ResizeObserver(() => {
      notifyHeight()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [onHeightChange])

  useEffect(() => {
    const next: Record<number, string> = {}
    for (const { file, index } of imageAttachments) {
      next[index] = URL.createObjectURL(file)
    }
    setImagePreviewUrlByIndex(next)
    setLoadedPreviewByIndex({})
    return () => {
      for (const value of Object.values(next)) {
        URL.revokeObjectURL(value)
      }
    }
  }, [imageAttachments])

  useEffect(() => {
    if (!isVoiceMode || !voiceControllerRef.current) {
      return
    }
    void voiceControllerRef.current.updateSettings(resolvedVoiceSettings)
  }, [isVoiceMode, resolvedVoiceSettings])

  const clearFilePickerSelection = () => {
    const inputElement = fileInputRef.current
    if (!inputElement) {
      return
    }
    inputElement.value = ""
  }

  const openFilePicker = () => {
    clearFilePickerSelection()
    fileInputRef.current?.click()
  }

  const handleSubmit = useCallback(async () => {
    const normalizedInput = input.trim()
    if ((!normalizedInput && attachments.length === 0) || isLoading) {
      return
    }

    if (isVoiceMode) {
      if (!normalizedInput || attachments.length > 0) {
        return
      }
      const controller = voiceControllerRef.current
      if (!controller) {
        return
      }
      await controller.sendText(normalizedInput)
      pendingManualVoiceTextRef.current = normalizedInput
      setInput("")
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto"
      }
      return
    }

    onSendMessage(normalizedInput, attachments.length > 0 ? attachments : undefined)
    setInput("")
    setAttachments([])
    clearFilePickerSelection()
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [attachments, input, isLoading, isVoiceMode, onSendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files ? Array.from(e.target.files) : []
    if (selectedFiles.length > 0) {
      setAttachments((prev) => [...prev, ...selectedFiles])
    }
    e.target.value = ""
  }

  const buildPastedFileName = (file: File, index: number): string => {
    const existing = (file.name || "").trim()
    if (existing) {
      return existing
    }
    const mime = (file.type || "").toLowerCase()
    if (mime.includes("png")) return `pasted-image-${Date.now()}-${index + 1}.png`
    if (mime.includes("jpeg") || mime.includes("jpg")) return `pasted-image-${Date.now()}-${index + 1}.jpg`
    if (mime.includes("webp")) return `pasted-image-${Date.now()}-${index + 1}.webp`
    if (mime.includes("gif")) return `pasted-image-${Date.now()}-${index + 1}.gif`
    return `pasted-image-${Date.now()}-${index + 1}`
  }

  const normalizePastedFile = (file: File, index: number): File => {
    const nextName = buildPastedFileName(file, index)
    if (nextName === file.name) {
      return file
    }
    return new File([file], nextName, {
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
    })
  }

  const handleTextareaPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || [])
    if (items.length === 0) {
      return
    }

    const pastedImages = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map((file, index) => normalizePastedFile(file, index))

    if (pastedImages.length === 0) {
      return
    }

    e.preventDefault()
    setAttachments((prev) => [...prev, ...pastedImages])
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
    clearFilePickerSelection()
  }

  const markPreviewLoaded = (index: number) => {
    setLoadedPreviewByIndex((prev) => {
      if (prev[index]) {
        return prev
      }
      return {
        ...prev,
        [index]: true,
      }
    })
  }

  const toggleRecording = () => {
    if (isVoiceMode) {
      return
    }
    if (isRecording) {
      setIsRecording(false)
    } else {
      setIsRecording(true)
    }
  }

  const handleStartVoiceMode = useCallback(async () => {
    if (!voiceEnabled || isLoading || isVoiceConnecting || isVoiceMode || !voiceService || !onPrepareVoiceSession) {
      return
    }
    clearVoiceConnectTimeout()
    setIsRecording(false)
    setVoiceEntryState("connecting")

    try {
      const prepared = await onPrepareVoiceSession()
      const conversationId = prepared.conversationId.trim()
      if (!conversationId) {
        throw new Error("voice conversation is required")
      }
      voiceConversationIdRef.current = conversationId
      const controller = getVoiceController()
      if (!controller) {
        throw new Error("voice service unavailable")
      }
      await controller.connect({
        sessionId: prepared.sessionId?.trim() || undefined,
        settings: resolvedVoiceSettings,
      })
      setVoiceEntryState("active")
    } catch {
      resetVoiceUiState()
    }
  }, [
    clearVoiceConnectTimeout,
    getVoiceController,
    isLoading,
    isVoiceConnecting,
    isVoiceMode,
    onPrepareVoiceSession,
    resetVoiceUiState,
    resolvedVoiceSettings,
    voiceEnabled,
    voiceService,
  ])

  const handleStopVoiceMode = useCallback(() => {
    void disconnectVoiceController("manual_close")
  }, [disconnectVoiceController])

  const handleToggleVoiceMicMuted = useCallback(async () => {
    const nextMuted = !isVoiceMicMuted
    setIsVoiceMicMuted(nextMuted)
    try {
      await voiceControllerRef.current?.setMicrophoneMuted(nextMuted)
    } catch {
      setIsVoiceMicMuted((previous) => !previous)
    }
  }, [isVoiceMicMuted])

  const handleToggleVoiceSpeakerMuted = useCallback(async () => {
    const nextMuted = !isVoiceSpeakerMuted
    setIsVoiceSpeakerMuted(nextMuted)
    try {
      await voiceControllerRef.current?.setSpeakerMuted(nextMuted)
    } catch {
      setIsVoiceSpeakerMuted((previous) => !previous)
    }
  }, [isVoiceSpeakerMuted])

  const voiceEntryAriaLabel = getVoiceEntryAriaLabel(voiceEntryState)
  const voiceEntryButtonDisabled = isLoading || isVoiceConnecting || !voiceService || !onPrepareVoiceSession

  const voiceButtonClassName =
    "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border bg-background px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary/55"

  const shouldRenderAttachmentTray = attachments.length > 0

  return (
    <div
      ref={containerRef}
      className={cn(
        "mx-auto w-full px-4 pb-5 transition-[max-width] duration-300",
        "max-w-3xl"
      )}
    >
      <div
        className={cn(
          "relative overflow-hidden border border-border bg-card shadow-sm transition-[border-radius,box-shadow,background,border-color] focus-within:border-ring/30 focus-within:shadow-sm",
          isVoiceMode
            ? "rounded-[1.75rem] bg-card shadow-[0_10px_24px_-22px_rgba(15,23,42,0.38)]"
            : "rounded-[1.75rem]"
        )}
      >
        {shouldRenderAttachmentTray ? (
          <div className={cn("px-4 pt-3", isVoiceMode && "min-h-[3.5rem] pb-1")}>
            {imageAttachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2">
                {imageAttachments.map(({ file, index }) => {
                  const previewUrl = imagePreviewUrlByIndex[index] || ""
                  const loaded = Boolean(loadedPreviewByIndex[index])
                  return (
                    <div
                      key={`${file.name}-${file.lastModified}-${index}`}
                      className="relative h-[76px] w-[76px] overflow-hidden rounded-2xl border border-border/70 bg-secondary/50"
                    >
                      {!loaded ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="inline-flex size-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground/70" />
                        </div>
                      ) : null}
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt={file.name || "attachment image"}
                          className={cn(
                            "h-full w-full object-cover transition-opacity duration-200",
                            loaded ? "opacity-100" : "opacity-0"
                          )}
                          onLoad={() => markPreviewLoaded(index)}
                          onError={() => markPreviewLoaded(index)}
                        />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/70"
                        aria-label="移除图片附件"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}

            {fileAttachments.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {fileAttachments.map(({ file, index }) => (
                  <div
                    key={`${file.name}-${file.lastModified}-${index}`}
                    className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs text-foreground"
                  >
                    <FileIcon className="size-3 text-muted-foreground" />
                    <span className="max-w-32 truncate">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(index)}
                      className="ml-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="移除文件附件"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {isVoiceMode ? (
          <>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaInput}
              onPaste={handleTextareaPaste}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false
              }}
              placeholder="不方便说话，你也可以打字"
              rows={1}
              autoFocus
              className={cn(
                "w-full resize-none bg-transparent px-4 pb-3 text-[16px] leading-7 text-foreground outline-none placeholder:text-muted-foreground sm:px-5 sm:text-[17px]",
                attachments.length > 0 ? "pt-4" : "pt-10 sm:pt-11"
              )}
              style={{ minHeight: "96px", maxHeight: "164px" }}
              disabled={isLoading}
            />

            <div className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:pb-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.json,.md"
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                type="button"
                onClick={openFilePicker}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-secondary/55"
                aria-label="上传附件"
                disabled
              >
                <Paperclip className="size-5" />
              </button>
              <div className="hidden h-8 w-px shrink-0 bg-border/70 sm:block" />
              <button
                type="button"
                onClick={() => {
                  void handleToggleVoiceMicMuted()
                }}
                className={voiceButtonClassName}
                aria-label={isVoiceMicMuted ? "取消麦克风静音" : "麦克风静音"}
              >
                <VoiceLevelIndicator active={!isVoiceMicMuted} />
                {isVoiceMicMuted ? <MicOff className="size-4.5" /> : <Mic className="size-4.5" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleToggleVoiceSpeakerMuted()
                }}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-secondary/55"
                aria-label={isVoiceSpeakerMuted ? "取消扬声器静音" : "扬声器静音"}
              >
                {isVoiceSpeakerMuted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
              </button>
              <button
                type="button"
                onClick={() => setIsVoiceSettingsOpen(true)}
                className={cn(voiceButtonClassName, "min-w-[9rem] justify-between px-4")}
                aria-label="语音设置"
              >
                <span className="inline-flex items-center gap-2">
                  <Settings2 className="size-4" />
                  <span className="hidden min-[360px]:inline font-semibold">{selectedVoiceLabel}</span>
                </span>
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            </div>

              <button
                type="button"
                onClick={() => {
                  handleStopVoiceMode()
                }}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-foreground px-6 text-sm font-semibold text-background transition-opacity hover:opacity-90 sm:min-w-[7.5rem]"
              >
              停止
            </button>
          </div>
          </>
        ) : (
          <div className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <div className="flex shrink-0 items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.json,.md"
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                type="button"
                onClick={openFilePicker}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-secondary/55"
                aria-label="上传附件"
              >
                <Paperclip className="size-5" />
              </button>
              <div className="h-8 w-px shrink-0 bg-border/70" />
            </div>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaInput}
              onPaste={handleTextareaPaste}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false
              }}
              placeholder={isRecording ? "正在录音..." : "你想知道什么？"}
              rows={1}
              className={cn(
                "min-h-10 flex-1 resize-none bg-transparent py-2 text-[16px] leading-7 text-foreground outline-none placeholder:text-muted-foreground sm:text-[17px]",
                isRecording && "placeholder:text-red-400"
              )}
              style={{ maxHeight: "200px" }}
              disabled={isLoading}
            />

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={toggleRecording}
                className={cn(
                  "flex size-10 items-center justify-center rounded-full transition-colors",
                  isRecording
                    ? "bg-red-500/10 text-red-500"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                )}
                aria-label={isRecording ? "停止录音" : "语音输入"}
              >
                {isRecording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>

              {voiceEnabled ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleStartVoiceMode()
                  }}
                  className={cn(
                    "group flex flex-col justify-center rounded-full focus:outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    voiceEntryButtonDisabled ? "cursor-not-allowed" : "hover:opacity-80",
                    isLoading && !isVoiceConnecting ? "opacity-45" : "opacity-100"
                  )}
                  aria-label={voiceEntryAriaLabel}
                  disabled={voiceEntryButtonDisabled}
                >
                  <div
                    className={cn(
                      "relative flex h-10 aspect-square items-center justify-center gap-0.5 rounded-full ring-inset transition-colors duration-200 ease-out",
                      isVoiceConnecting
                        ? "bg-secondary text-muted-foreground ring-0"
                        : "bg-foreground text-background ring-1 ring-transparent"
                    )}
                  >
                    <AudioWaveIcon state={isVoiceConnecting ? "connecting" : "idle"} />
                  </div>
                </button>
              ) : null}

              {isLoading ? (
                <Button
                  size="sm"
                  className="size-10 rounded-full bg-claude-sienna p-0 text-white hover:bg-claude-sienna/90"
                  onClick={onStop}
                >
                  <Square className="size-3 fill-current" />
                  <span className="sr-only">停止</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  className={cn(
                    "size-10 rounded-full p-0 transition-colors",
                    input.trim() || attachments.length > 0
                      ? "bg-foreground text-background hover:opacity-80"
                      : "bg-muted text-muted-foreground cursor-not-allowed"
                  )}
                  onClick={() => {
                    void handleSubmit()
                  }}
                  disabled={(!input.trim() && attachments.length === 0) || isVoiceMode}
                >
                  <ArrowUp className="size-4" />
                  <span className="sr-only">发送</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <VoiceSettingsSheet
        open={isVoiceSettingsOpen}
        onOpenChange={setIsVoiceSettingsOpen}
        selectedVoiceId={selectedVoiceId}
        onSelectVoice={setSelectedVoiceId}
        selectedPersonalityId={selectedVoicePersonalityId}
        onSelectPersonality={setSelectedVoicePersonalityId}
        customPrompt={savedVoicePrompt}
        onSaveCustomPrompt={setSavedVoicePrompt}
        speed={voiceSpeed}
        onSpeedChange={setVoiceSpeed}
      />
    </div>
  )
}
