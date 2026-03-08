"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
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
import { VoiceSettingsSheet, getVoiceOptionLabel, type VoiceOptionId, type VoicePersonalityId } from "@/components/voice-settings-sheet"
import { cn } from "@/lib/utils"

function AudioWaveIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="4" y="10" width="2" height="4" rx="1" fill="currentColor" />
      <rect x="8" y="7" width="2" height="10" rx="1" fill="currentColor" />
      <rect x="12" y="4" width="2" height="16" rx="1" fill="currentColor" />
      <rect x="16" y="7" width="2" height="10" rx="1" fill="currentColor" />
      <rect x="20" y="10" width="2" height="4" rx="1" fill="currentColor" />
    </svg>
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
}

export function ChatInput({
  onSendMessage,
  isLoading,
  onStop,
  onHeightChange,
  voiceEnabled = true,
}: ChatInputProps) {
  const [input, setInput] = useState("")
  const [isRecording, setIsRecording] = useState(false)
  const [isVoiceMode, setIsVoiceMode] = useState(false)
  const [isVoiceMicMuted, setIsVoiceMicMuted] = useState(false)
  const [isVoiceSpeakerMuted, setIsVoiceSpeakerMuted] = useState(false)
  const [isVoiceSettingsOpen, setIsVoiceSettingsOpen] = useState(false)
  const [selectedVoiceId, setSelectedVoiceId] = useState<VoiceOptionId>("leo")
  const [selectedVoicePersonalityId, setSelectedVoicePersonalityId] = useState<VoicePersonalityId>("custom")
  const [savedVoicePrompt, setSavedVoicePrompt] = useState("")
  const [voiceSpeed, setVoiceSpeed] = useState(1)
  const [attachments, setAttachments] = useState<File[]>([])
  const [imagePreviewUrlByIndex, setImagePreviewUrlByIndex] = useState<Record<number, string>>({})
  const [loadedPreviewByIndex, setLoadedPreviewByIndex] = useState<Record<number, true>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)

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

  const fileAttachments = useMemo(
    () =>
      attachments
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => !isImageAttachment(file)),
    [attachments]
  )

  useEffect(() => {
    if (!voiceEnabled && isVoiceMode) {
      setIsVoiceMode(false)
      setIsVoiceMicMuted(false)
      setIsVoiceSpeakerMuted(false)
      setIsVoiceSettingsOpen(false)
    }
  }, [isVoiceMode, voiceEnabled])

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

  const handleSubmit = useCallback(() => {
    if ((!input.trim() && attachments.length === 0) || isLoading || isVoiceMode) return
    onSendMessage(input.trim(), attachments.length > 0 ? attachments : undefined)
    setInput("")
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [attachments, input, isLoading, isVoiceMode, onSendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229 || isVoiceMode) {
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (isVoiceMode) {
      return
    }
    setInput(e.target.value)
    const el = e.target
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments((prev) => [...prev, ...Array.from(e.target.files!)])
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
    if (isVoiceMode) {
      return
    }

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

  const handleStartVoiceMode = () => {
    if (!voiceEnabled || isLoading) {
      return
    }
    setIsRecording(false)
    setIsVoiceMode(true)
  }

  const handleStopVoiceMode = () => {
    setIsVoiceMode(false)
    setIsVoiceMicMuted(false)
    setIsVoiceSpeakerMuted(false)
    setIsVoiceSettingsOpen(false)
  }

  const voiceButtonClassName =
    "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border bg-background px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary/55"

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
        {attachments.length > 0 && (
          <div className={cn("px-4 pt-3", isVoiceMode && "px-5 pt-4")}>
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
        )}

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
          placeholder={isVoiceMode ? "Grok 怎么能帮忙?" : isRecording ? "正在录音..." : "你想知道什么？"}
          rows={1}
          readOnly={isVoiceMode}
          className={cn(
            "w-full resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
            isVoiceMode
              ? "px-5 pt-5 pb-3 text-[16px] leading-7 placeholder:text-muted-foreground sm:px-6 sm:pt-6 sm:text-[17px]"
              : "px-5 pt-5 pb-3 text-[16px] leading-7 placeholder:text-muted-foreground sm:px-6 sm:pt-5 sm:text-[17px]",
            isRecording && !isVoiceMode && "placeholder:text-red-400"
          )}
          style={{ minHeight: isVoiceMode ? "88px" : "88px", maxHeight: isVoiceMode ? "164px" : "200px" }}
          disabled={isLoading && !isVoiceMode}
        />

        {isVoiceMode ? (
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
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-secondary/55"
                aria-label="上传附件"
              >
                <Paperclip className="size-5" />
              </button>
              <div className="hidden h-8 w-px shrink-0 bg-border/70 sm:block" />
              <button
                type="button"
                onClick={() => setIsVoiceMicMuted((value) => !value)}
                className={voiceButtonClassName}
                aria-label={isVoiceMicMuted ? "取消麦克风静音" : "麦克风静音"}
              >
                <VoiceLevelIndicator active={!isVoiceMicMuted} />
                {isVoiceMicMuted ? <MicOff className="size-4.5" /> : <Mic className="size-4.5" />}
              </button>
              <button
                type="button"
                onClick={() => setIsVoiceSpeakerMuted((value) => !value)}
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
              onClick={handleStopVoiceMode}
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-foreground px-6 text-sm font-semibold text-background transition-opacity hover:opacity-90 sm:min-w-[7.5rem]"
            >
              停止
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between px-3.5 pb-3">
            <div className="flex items-center gap-2">
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
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-secondary/55"
                aria-label="上传附件"
              >
                <Paperclip className="size-5" />
              </button>
              <div className="h-8 w-px shrink-0 bg-border/70" />
            </div>

            <div className="flex items-center gap-1.5">
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
                  onClick={handleStartVoiceMode}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-full bg-foreground text-background transition-opacity",
                    isLoading ? "cursor-not-allowed opacity-45" : "hover:opacity-80"
                  )}
                  aria-label="语音对话"
                  disabled={isLoading}
                >
                  <AudioWaveIcon className="size-4" />
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
                  onClick={handleSubmit}
                  disabled={!input.trim() && attachments.length === 0}
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
