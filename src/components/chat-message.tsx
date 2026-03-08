"use client"

import { useRef, useState, type MouseEvent } from "react"
import type {
  ChatAttachment,
  ChatDeepSearchResearch,
  ChatReasoningEventDetail,
} from "@/domain/chat/types"
import { hasTauriRuntime } from "@/app/runtime-info"
import { buildMessagePdfBytes } from "@/features/chat/export-message-pdf"
import { openExternalUrl } from "@/lib/open-external-url"
import { MarkdownContent } from "./markdown-content/index"
import {
  buildCitationItems,
  resolveSourceCount,
  shouldHidePdfExportForGeneratedContent,
} from "./chat-message-citations"
import { UserMessageBubble } from "./chat-message-attachments"
import { ChatMessageActionBar } from "./chat-message-actions"

export { buildCitationItems, extractTrailingKeyCitationEntries, shouldHidePdfExportForGeneratedContent } from "./chat-message-citations"

const OPEN_REASONING_DRAWER_EVENT = "nbsearch:open-reasoning-drawer"

export interface RenderChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  attachments?: ChatAttachment[]
  createdAt?: number
  responseId?: string
  previousResponseId?: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningActive?: boolean
  reasoningDurationSeconds?: number
  research?: ChatDeepSearchResearch
}

function triggerBinaryDownload(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const blob = new Blob([bytes], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.rel = "noreferrer noopener"
  anchor.target = "_blank"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 1200)
}

export function ChatMessage({
  message,
  onRegenerate,
  regenerateDisabled = false,
  actionsAlwaysVisible = false,
  pdfExportMeta,
}: {
  message: RenderChatMessage
  onRegenerate?: (message: RenderChatMessage) => void
  regenerateDisabled?: boolean
  actionsAlwaysVisible?: boolean
  pdfExportMeta?: {
    title: string
    round: number
    fileName: string
  }
}) {
  const isTauri = hasTauriRuntime()
  const messageContentRef = useRef<HTMLDivElement | null>(null)
  const [pdfExportState, setPdfExportState] = useState<"idle" | "loading" | "done" | "error">("idle")
  const isUser = message.role === "user"
  const isStreamingAssistant = !isUser && message.id === "streaming_assistant"
  const hidePdfExport = !isUser && !isStreamingAssistant && shouldHidePdfExportForGeneratedContent(message.content)
  const canExportPdf = !isUser && !isStreamingAssistant && Boolean(pdfExportMeta) && !hidePdfExport
  const sourceCount = !isUser && !isStreamingAssistant ? resolveSourceCount(message.reasoningEvents) : 0
  const citationItems =
    !isUser && !isStreamingAssistant
      ? buildCitationItems(message.research, message.reasoningEvents, message.content)
      : []
  const showSourceSummary = sourceCount > 0
  const setPdfStateWithReset = (state: "done" | "error") => {
    setPdfExportState(state)
    window.setTimeout(() => {
      setPdfExportState((prev) => (prev === "loading" ? prev : "idle"))
    }, 4200)
  }

  const onExportPdf = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!pdfExportMeta || pdfExportState === "loading") {
      return
    }

    setPdfExportState("loading")
    try {
      const pdfBytes = await buildMessagePdfBytes({
        title: pdfExportMeta.title,
        round: pdfExportMeta.round,
        content: message.content,
        element: messageContentRef.current,
      })

      if (isTauri) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { invoke } = await import("@tauri-apps/api/core")
        const targetPath = await save({
          defaultPath: pdfExportMeta.fileName,
          title: "导出 PDF",
          filters: [
            {
              name: "PDF",
              extensions: ["pdf"],
            },
          ],
        })
        if (!targetPath) {
          setPdfExportState("idle")
          return
        }

        await invoke("save_pdf_document", {
          bytes: Array.from(pdfBytes),
          fileName: pdfExportMeta.fileName,
          destinationPath: targetPath,
        })
      } else {
        triggerBinaryDownload(pdfBytes, pdfExportMeta.fileName, "application/pdf")
      }

      setPdfStateWithReset("done")
    } catch {
      setPdfStateWithReset("error")
    }
  }

  const onOpenReasoningDrawer = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    window.dispatchEvent(
      new CustomEvent(OPEN_REASONING_DRAWER_EVENT, {
        detail: { messageId: message.id },
      })
    )
  }

  if (isUser) {
    return <UserMessageBubble content={message.content} attachments={message.attachments} />
  }

  return (
    <div className="group/message px-6 py-4 text-[16px] leading-7 text-foreground">
      <div ref={messageContentRef}>
        <MarkdownContent
          content={message.content}
          streaming={isStreamingAssistant}
          reasoningEvents={message.reasoningEvents}
          reasoningActive={message.reasoningActive}
          reasoningDurationSeconds={message.reasoningDurationSeconds}
          research={message.research}
          messageId={message.id}
        />
        {citationItems.length > 0 ? (
          <section className="mt-3 rounded-2xl border border-foreground/8 bg-secondary/10 px-4 py-3">
            <h4 className="text-[15px] font-semibold leading-6 text-foreground">Key Citations:</h4>
            <ul className="mt-1.5 list-disc space-y-1.5 pl-6 text-[15px] leading-6">
              {citationItems.map((item) => (
                <li key={item.key}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-words text-foreground/90 underline decoration-foreground/40 underline-offset-2 hover:text-foreground"
                    onClick={(event) => {
                      event.preventDefault()
                      void openExternalUrl(item.url)
                    }}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {!isStreamingAssistant ? (
        <ChatMessageActionBar
          onRegenerate={onRegenerate ? () => onRegenerate(message) : undefined}
          regenerateDisabled={regenerateDisabled}
          onExportPdf={onExportPdf}
          canExportPdf={canExportPdf}
          pdfExportState={pdfExportState}
          actionsAlwaysVisible={actionsAlwaysVisible}
          hidePdfExport={hidePdfExport}
          showSourceSummary={showSourceSummary}
          sourceCount={sourceCount}
          onOpenReasoningDrawer={onOpenReasoningDrawer}
        />
      ) : null}
    </div>
  )
}

export function TypingIndicator({
  elapsedSeconds = 0,
  label = "思考中",
}: {
  elapsedSeconds?: number
  label?: string
}) {
  return (
    <div className="flex px-6 py-4">
      <div className="inline-flex items-center gap-2 rounded-full bg-secondary/40 px-3 py-1.5 text-sm text-muted-foreground">
        <span className="inline-flex size-2 rounded-full bg-(--color-claude-warm-gray) animate-pulse" />
        <span className="whitespace-nowrap">{elapsedSeconds > 0 ? `${label} · ${elapsedSeconds}s` : label}</span>
      </div>
    </div>
  )
}
