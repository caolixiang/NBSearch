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
      />
    </div>
  )
}

export function TypingIndicator() {
  return (
    <div className="flex px-6 py-4">
      <div className="flex items-center gap-1.5 pt-2">
        <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-claude-warm-gray)] [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-claude-warm-gray)] [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-claude-warm-gray)] [animation-delay:300ms]" />
      </div>
    </div>
  )
}
