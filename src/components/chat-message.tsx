"use client"

import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import { cn } from "@/lib/utils"
import { MarkdownContent } from "./markdown-content/index"

export interface RenderChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningActive?: boolean
  reasoningDurationSeconds?: number
}

export function ChatMessage({ message }: { message: RenderChatMessage }) {
  const isUser = message.role === "user"
  const isStreamingAssistant = !isUser && message.id === "streaming_assistant"

  if (isUser) {
    return (
      <div className="flex justify-end px-6 py-4">
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[16px] leading-7 text-foreground">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-4 text-[16px] leading-7 text-foreground">
      <MarkdownContent
        content={message.content}
        streaming={isStreamingAssistant}
        reasoningEvents={message.reasoningEvents}
        reasoningActive={message.reasoningActive}
        reasoningDurationSeconds={message.reasoningDurationSeconds}
      />
    </div>
  )
}

export function TypingIndicator({ elapsedSeconds = 0 }: { elapsedSeconds?: number }) {
  return (
    <div className="flex px-6 py-4">
      <div className="inline-flex items-center gap-2 rounded-full bg-secondary/40 px-3 py-1.5 text-sm text-muted-foreground">
        <span className="inline-flex size-2 rounded-full bg-[var(--color-claude-warm-gray)] animate-pulse" />
        <span className="whitespace-nowrap">{elapsedSeconds > 0 ? `思考中 · ${elapsedSeconds}s` : "思考中"}</span>
      </div>
    </div>
  )
}
