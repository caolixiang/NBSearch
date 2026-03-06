"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { ArrowUp, Square, Paperclip, Mic, MicOff, X, File as FileIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// Audio wave icon for LiveKit voice button
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

interface ChatInputProps {
  onSendMessage: (text: string, attachments?: File[]) => void
  onVoiceStart?: () => void
  isLoading: boolean
  onStop?: () => void
  onHeightChange?: (height: number) => void
}

export function ChatInput({
  onSendMessage,
  onVoiceStart,
  isLoading,
  onStop,
  onHeightChange,
}: ChatInputProps) {
  const [input, setInput] = useState("")
  const [isRecording, setIsRecording] = useState(false)
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

  const fileAttachments = useMemo(
    () =>
      attachments
        .map((file, index) => ({ file, index }))
        .filter(({ file }) => !isImageAttachment(file)),
    [attachments]
  )

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
    if ((!input.trim() && attachments.length === 0) || isLoading) return
    onSendMessage(input.trim(), attachments.length > 0 ? attachments : undefined)
    setInput("")
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [attachments, input, isLoading, onSendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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

    // Prevent browsers from pasting image URL/plaintext into textarea when an image blob is present.
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
    if (isRecording) {
      setIsRecording(false)
      // In production, stop recording and transcribe
    } else {
      setIsRecording(true)
      // In production, start Web Speech API / whisper
    }
  }

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-3xl px-4 pb-5">
      <div className="relative rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:border-ring/40">
        {/* Attachments preview */}
        {attachments.length > 0 && (
          <div className="px-4 pt-3">
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

        {/* Textarea */}
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
            "w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base text-foreground outline-none placeholder:text-muted-foreground",
            isRecording && "placeholder:text-red-400"
          )}
          style={{ minHeight: "44px", maxHeight: "200px" }}
          disabled={isLoading}
        />

        {/* Bottom action bar */}
        <div className="flex items-center justify-between px-3 pb-3">
          {/* Left: attachment button */}
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.json,.md"
              className="hidden"
              onChange={handleFileSelect}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label="上传附件"
            >
              <Paperclip className="size-4" />
            </button>
          </div>

          {/* Right: mic, voice, send */}
          <div className="flex items-center gap-1.5">
            {/* Mic (voice-to-text) */}
            <button
              onClick={toggleRecording}
              className={cn(
                "flex size-8 items-center justify-center rounded-lg transition-colors",
                isRecording
                  ? "bg-red-500/10 text-red-500"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
              aria-label={isRecording ? "停止录音" : "语音输入"}
            >
              {isRecording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>

            {/* LiveKit voice button - Grok style dark circle */}
            <button
              onClick={onVoiceStart}
              className="flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
              aria-label="语音对话"
            >
              <AudioWaveIcon className="size-4" />
            </button>

            {/* Send / Stop */}
            {isLoading ? (
              <Button
                size="sm"
                className="size-9 rounded-full bg-claude-sienna p-0 text-white hover:bg-claude-sienna/90"
                onClick={onStop}
              >
                <Square className="size-3 fill-current" />
                <span className="sr-only">停止</span>
              </Button>
            ) : (
              <Button
                size="sm"
                className={cn(
                  "size-9 rounded-full p-0 transition-colors",
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
      </div>
    </div>
  )
}
