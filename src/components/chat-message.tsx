"use client"

import { User } from "lucide-react"
import { cn } from "@/lib/utils"
import { GrokAvatar } from "./claude-logo"
import { MarkdownContent } from "./markdown-content"

export interface RenderChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

export function ChatMessage({ message }: { message: RenderChatMessage }) {
  const isUser = message.role === "user"

  return (
    <div className={cn("flex gap-3 px-6 py-5", isUser ? "justify-end" : "") }>
      {!isUser && <GrokAvatar size="sm" />}
      <div
        className={cn(
          "max-w-[75%] space-y-2",
          isUser
            ? "rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-foreground"
            : "text-foreground"
        )}
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
      {isUser && (
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full border border-black bg-white text-black">
          <User className="size-3.5" />
        </div>
      )}
    </div>
  )
}

export function TypingIndicator() {
  return (
    <div className="flex gap-3 px-6 py-5">
      <GrokAvatar size="sm" />
      <div className="flex items-center gap-1.5 pt-2">
        <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-claude-warm-gray)] [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-claude-warm-gray)] [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-claude-warm-gray)] [animation-delay:300ms]" />
      </div>
    </div>
  )
}
