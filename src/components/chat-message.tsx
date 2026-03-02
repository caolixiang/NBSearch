"use client"

import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import { cn } from "@/lib/utils"
import {
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  type LucideIcon,
} from "lucide-react"
import { MarkdownContent } from "./markdown-content/index"

export interface RenderChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningActive?: boolean
  reasoningDurationSeconds?: number
}

const CJK_CHAR_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/
const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv"])
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "odt", "pages", "txt", "rtf", "md"])
const CODE_TEXT_EXTENSIONS = new Set(["json", "xml", "yaml", "yml", "toml", "ini", "log"])

function parseUserMessageContent(content: string): { text: string; attachments: string[] } {
  const textLines: string[] = []
  const attachments: string[] = []

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*\[附件\]\s*(.+?)\s*$/)
    if (match?.[1]) {
      attachments.push(match[1])
      continue
    }
    textLines.push(line)
  }

  return {
    text: textLines.join("\n").trim(),
    attachments,
  }
}

function resolveAttachmentIcon(fileName: string): LucideIcon {
  const ext = fileName.split(".").pop()?.trim().toLowerCase() || ""
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return FileSpreadsheet
  }
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return FileText
  }
  if (CODE_TEXT_EXTENSIONS.has(ext)) {
    return FileCode2
  }
  return File
}

function characterUnits(value: string): number {
  if (!value) {
    return 0
  }
  let total = 0
  for (const char of value) {
    total += CJK_CHAR_PATTERN.test(char) ? 1 : 0.5
  }
  return total
}

function truncateAttachmentName(fileName: string, maxUnits = 20): string {
  const input = fileName.trim()
  if (!input) {
    return ""
  }
  if (characterUnits(input) <= maxUnits) {
    return input
  }

  let units = 0
  let out = ""
  for (const char of input) {
    const next = CJK_CHAR_PATTERN.test(char) ? 1 : 0.5
    if (units + next > maxUnits) {
      break
    }
    out += char
    units += next
  }

  const normalized = out.trim()
  return normalized ? `${normalized}...` : `${input.slice(0, 1)}...`
}

export function ChatMessage({ message }: { message: RenderChatMessage }) {
  const isUser = message.role === "user"
  const isStreamingAssistant = !isUser && message.id === "streaming_assistant"

  if (isUser) {
    const { text, attachments } = parseUserMessageContent(message.content)
    return (
      <div className="flex justify-end px-6 py-4">
        <div className="max-w-[75%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-[16px] leading-7 text-foreground">
          {text ? <p className="whitespace-pre-wrap">{text}</p> : null}
          {attachments.length > 0 ? (
            <div className={cn("space-y-2", text ? "mt-2.5" : "")}>
              {attachments.map((fileName, index) => {
                const Icon = resolveAttachmentIcon(fileName)
                return (
                  <div
                    key={`${fileName}-${index}`}
                    className="flex items-center gap-2 rounded-lg bg-background/40 px-2.5 py-1.5 text-[15px] leading-6 text-foreground"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                      {truncateAttachmentName(fileName)}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}
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
