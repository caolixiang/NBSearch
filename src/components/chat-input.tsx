"use client"

import { useState, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { ArrowUp, Square, Paperclip, Mic, MicOff, X } from "lucide-react"
import { cn } from "@/lib/utils"

// DeepSearch icon (spiral/swirl like Grok's)
function DeepSearchIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2a10 10 0 0 1 0 20 10 10 0 0 1 0-20" />
      <path d="M12 2c3 3 4.5 6.5 4.5 10S15 19 12 22" />
      <path d="M12 2c-3 3-4.5 6.5-4.5 10S9 19 12 22" />
      <line x1="2" y1="12" x2="22" y2="12" />
    </svg>
  )
}

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
}

export function ChatInput({
  onSendMessage,
  onVoiceStart,
  isLoading,
  onStop,
}: ChatInputProps) {
  const [input, setInput] = useState("")
  const [deepSearch, setDeepSearch] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [attachments, setAttachments] = useState<File[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(() => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return
    onSendMessage(input.trim(), attachments.length > 0 ? attachments : undefined)
    setInput("")
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [input, isLoading, onSendMessage, attachments])

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
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
    <div className="mx-auto w-full max-w-[48rem] px-4 pb-4">
      <div className="relative rounded-2xl border border-border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:border-ring/40">
        {/* Attachments preview */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {attachments.map((file, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs text-foreground">
                <Paperclip className="size-3 text-muted-foreground" />
                <span className="max-w-32 truncate">{file.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="ml-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          placeholder={isRecording ? "正在录音..." : "你在想什么？"}
          rows={1}
          className={cn(
            "w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm text-foreground outline-none placeholder:text-muted-foreground",
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
              accept="image/*,.pdf,.doc,.docx,.txt,.csv,.json,.md"
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
                className="size-9 rounded-full bg-[var(--color-claude-sienna)] p-0 text-white hover:bg-[var(--color-claude-sienna)]/90"
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

      {/* DeepSearch toggle pill below input */}
      <div className="mt-2 flex items-center justify-center gap-2">
        <button
          onClick={() => setDeepSearch(!deepSearch)}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors",
            deepSearch
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30"
          )}
        >
          <DeepSearchIcon className="size-3.5" />
          <span>DeepSearch</span>
        </button>
      </div>
    </div>
  )
}
