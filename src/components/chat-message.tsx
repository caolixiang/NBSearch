"use client"

import { useRef, useState, type MouseEvent } from "react"
import type {
  ChatDeepSearchResearch,
  ChatInlineCitation,
  ChatReasoningEventDetail,
} from "@/domain/chat/types"
import { hasTauriRuntime } from "@/app/runtime-info"
import { buildMessagePdfBytes } from "@/features/chat/export-message-pdf"
import { openExternalUrl } from "@/lib/open-external-url"
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
  createdAt?: number
  responseId?: string
  previousResponseId?: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningActive?: boolean
  reasoningDurationSeconds?: number
  research?: ChatDeepSearchResearch
}

const CJK_CHAR_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/
const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv"])
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "odt", "pages", "txt", "rtf", "md"])
const CODE_TEXT_EXTENSIONS = new Set(["json", "xml", "yaml", "yml", "toml", "ini", "log"])
const OPEN_REASONING_DRAWER_EVENT = "nbsearch:open-reasoning-drawer"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function shouldHidePdfExportForGeneratedContent(content: string): boolean {
  if (!content || !content.includes("<tool-meta>")) {
    return false
  }

  const matches = content.matchAll(/<tool-meta>([\s\S]*?)<\/tool-meta>/gi)
  let sawGeneratedCard = false
  let sawNonGeneratedCard = false

  for (const match of matches) {
    const payloadText = (match[1] || "").trim()
    if (!payloadText) {
      continue
    }

    let payload: unknown
    try {
      payload = JSON.parse(payloadText) as unknown
    } catch {
      continue
    }
    if (!isRecord(payload) || !Array.isArray(payload.cards)) {
      continue
    }

    for (const card of payload.cards) {
      if (!isRecord(card)) {
        continue
      }
      const cardType = typeof card.type === "string" ? card.type.trim().toLowerCase() : ""
      if (!cardType) {
        continue
      }
      if (cardType === "generated_image" || cardType.includes("generated_image")) {
        sawGeneratedCard = true
        continue
      }
      sawNonGeneratedCard = true
    }
  }

  return sawGeneratedCard && !sawNonGeneratedCard
}

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

function resolveSourceCount(events: ChatReasoningEventDetail[] | undefined): number {
  if (!events || events.length === 0) {
    return 0
  }

  const countByCardId = new Map<string, number>()
  let totalWithoutCardId = 0

  for (const detail of events) {
    if (detail.kind !== "tool_result") {
      continue
    }

    const webSearchResults = Array.isArray(detail.result.webSearchResults) ? detail.result.webSearchResults : []
    const fromRows = webSearchResults.length
    const fromCount =
      typeof detail.result.webSearchResultsCount === "number" && Number.isFinite(detail.result.webSearchResultsCount)
        ? Math.max(0, Math.floor(detail.result.webSearchResultsCount))
        : 0
    const count = Math.max(fromRows, fromCount)
    if (count <= 0) {
      continue
    }

    const cardId = (detail.result.toolUsageCardId || "").trim()
    if (!cardId) {
      totalWithoutCardId += count
      continue
    }
    countByCardId.set(cardId, Math.max(countByCardId.get(cardId) || 0, count))
  }

  let total = totalWithoutCardId
  for (const count of countByCardId.values()) {
    total += count
  }
  return total
}

type CitationRenderItem = {
  key: string
  url: string
  label: string
}

type ParsedTailCitation = {
  url: string
  label: string
}

function normalizeCitationUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ""
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return ""
    }
    return parsed.href
  } catch {
    return ""
  }
}

function fallbackCitationLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./, "")
    const path = parsed.pathname === "/" ? "" : parsed.pathname
    const short = `${host}${path}`
    if (short.length <= 84) {
      return short
    }
    return `${short.slice(0, 81)}...`
  } catch {
    return url
  }
}

function cleanCitationLabel(input: string): string {
  return input
    .replace(/^[\s\-–—:：;；,.，。]+/, "")
    .replace(/[\s\-–—:：;；,.，。]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isKeyCitationsHeading(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[*_`~\s]+|[*_`~\s]+$/g, "")
    .replace(/[：:]\s*$/, "")
    .trim()
    .toLowerCase()
  return normalized === "key citations" || normalized === "key citation"
}

function parseTailCitationLine(line: string): ParsedTailCitation | null {
  const body = line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .trim()
  if (!body) {
    return null
  }

  const markdownLinkMatch = body.match(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/i)
  if (markdownLinkMatch) {
    const url = markdownLinkMatch[2] || ""
    const labelFromLink = cleanCitationLabel(markdownLinkMatch[1] || "")
    const labelFromLine = cleanCitationLabel(body.replace(markdownLinkMatch[0], ""))
    return {
      url,
      label: labelFromLink || labelFromLine,
    }
  }

  const parenthesizedUrlMatch = body.match(/[（(]\s*(https?:\/\/[^)\s]+)\s*[）)]/i)
  if (parenthesizedUrlMatch) {
    const url = parenthesizedUrlMatch[1] || ""
    return {
      url,
      label: cleanCitationLabel(body.replace(parenthesizedUrlMatch[0], "")),
    }
  }

  const bareUrlMatch = body.match(/https?:\/\/\S+/i)
  if (bareUrlMatch) {
    const rawUrl = bareUrlMatch[0] || ""
    const sanitizedUrl = rawUrl.replace(/[)>）.,，。;；!！?？]+$/g, "")
    return {
      url: sanitizedUrl,
      label: cleanCitationLabel(body.replace(rawUrl, "")),
    }
  }

  return null
}

export function extractTrailingKeyCitationEntries(content: string): ParsedTailCitation[] {
  if (!content) {
    return []
  }

  // Ignore machine metadata blocks that may contain many internal URLs.
  // They are not user-facing citations and should not leak into Key Citations.
  const sanitizedContent = content.replace(/<tool-meta>[\s\S]*?<\/tool-meta>/gi, "")
  const lines = sanitizedContent.split(/\r?\n/)
  let headingIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isKeyCitationsHeading(lines[index] || "")) {
      headingIndex = index
      break
    }
  }
  if (headingIndex < 0) {
    return []
  }

  const tailLines = lines.slice(headingIndex + 1)
  if (tailLines.length === 0 || !tailLines.some((line) => /https?:\/\//i.test(line))) {
    return []
  }

  const entries: ParsedTailCitation[] = []
  let pendingLabel = ""

  for (const line of tailLines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const parsed = parseTailCitationLine(trimmed)
    if (parsed) {
      const normalizedUrl = normalizeCitationUrl(parsed.url)
      if (!normalizedUrl) {
        pendingLabel = ""
        continue
      }
      const candidateLabel = cleanCitationLabel(parsed.label || pendingLabel)
      entries.push({
        url: normalizedUrl,
        label: candidateLabel || fallbackCitationLabel(normalizedUrl),
      })
      pendingLabel = ""
      continue
    }

    const plainText = cleanCitationLabel(trimmed.replace(/^[-*+]\s+/, ""))
    if (plainText) {
      pendingLabel = pendingLabel ? `${pendingLabel} ${plainText}` : plainText
    }
  }

  return entries
}

function collectCitationTitleByUrl(events: ChatReasoningEventDetail[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!events || events.length === 0) {
    return map
  }
  for (const detail of events) {
    if (detail.kind !== "tool_result" || !Array.isArray(detail.result.webSearchResults)) {
      continue
    }
    for (const row of detail.result.webSearchResults) {
      const normalizedUrl = normalizeCitationUrl(row.url || "")
      if (!normalizedUrl) {
        continue
      }
      const title = (row.title || "").trim()
      if (!title) {
        continue
      }
      if (!map.has(normalizedUrl)) {
        map.set(normalizedUrl, title)
      }
    }
  }
  return map
}

export function buildCitationItems(
  research: ChatDeepSearchResearch | undefined,
  events: ChatReasoningEventDetail[] | undefined,
  rawContent: string | undefined
): CitationRenderItem[] {
  const inlineRows = Array.isArray(research?.inlineCitations) ? research.inlineCitations : []

  const citationCardUrlById = new Map<string, string>()
  for (const row of research?.citationCards || []) {
    const cardId = row.cardId.trim()
    if (!cardId) {
      continue
    }
    const normalizedUrl = normalizeCitationUrl(row.url || "")
    if (!normalizedUrl) {
      continue
    }
    if (!citationCardUrlById.has(cardId)) {
      citationCardUrlById.set(cardId, normalizedUrl)
    }
  }

  const titleByUrl = collectCitationTitleByUrl(events)
  const rows: CitationRenderItem[] = []
  const seenInlineKeys = new Set<string>()
  const seenUrls = new Set<string>()

  const append = (entry: ChatInlineCitation) => {
    const directUrl = normalizeCitationUrl(entry.url || "")
    const mappedUrl = directUrl || citationCardUrlById.get(entry.cardId) || ""
    if (!mappedUrl) {
      return
    }
    const key = `${entry.cardId}\u0000${entry.citationId || ""}`
    if (seenInlineKeys.has(key)) {
      return
    }
    seenInlineKeys.add(key)
    seenUrls.add(mappedUrl)
    const label = titleByUrl.get(mappedUrl) || fallbackCitationLabel(mappedUrl)
    rows.push({
      key,
      url: mappedUrl,
      label,
    })
  }

  for (const row of inlineRows) {
    append(row)
  }

  const tailEntries = extractTrailingKeyCitationEntries(rawContent || "")
  for (let index = 0; index < tailEntries.length; index += 1) {
    const entry = tailEntries[index]
    if (!entry) {
      continue
    }
    if (seenUrls.has(entry.url)) {
      continue
    }
    seenUrls.add(entry.url)
    rows.push({
      key: `tail\u0000${index}\u0000${entry.url}`,
      url: entry.url,
      label: entry.label || titleByUrl.get(entry.url) || fallbackCitationLabel(entry.url),
    })
  }

  return rows
}

function RegenerateIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-4 stroke-[2]", className)}
      aria-hidden="true"
    >
      <path
        d="M4 20V15H4.31241M4.31241 15H9M4.31241 15C5.51251 18.073 8.50203 20.25 12 20.25C15.8582 20.25 19.0978 17.6016 20 14.0236M20 4V9H19.6876M19.6876 9H15M19.6876 9C18.4875 5.92698 15.498 3.75 12 3.75C8.14184 3.75 4.90224 6.3984 4 9.9764"
        stroke="currentColor"
      />
    </svg>
  )
}

function ExportPdfIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-4 stroke-[2]", className)}
      aria-hidden="true"
    >
      <path
        d="M14 3H7.8C6.11984 3 5.27976 3 4.63803 3.32698C4.07354 3.6146 3.6146 4.07354 3.32698 4.63803C3 5.27976 3 6.11984 3 7.8V16.2C3 17.8802 3 18.7202 3.32698 19.362C3.6146 19.9265 4.07354 20.3854 4.63803 20.673C5.27976 21 6.11984 21 7.8 21H16.2C17.8802 21 18.7202 21 19.362 20.673C19.9265 20.3854 20.3854 19.9265 20.673 19.362C21 18.7202 21 17.8802 21 16.2V10L14 3Z"
        stroke="currentColor"
      />
      <path d="M14 3V10H21" stroke="currentColor" />
      <path d="M12 12V18" stroke="currentColor" />
      <path d="M9.5 15.5L12 18L14.5 15.5" stroke="currentColor" />
    </svg>
  )
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
  const reasoningPanelId = `reasoning-panel-${message.id}`

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

    const panel = document.getElementById(reasoningPanelId)
    if (panel) {
      panel.scrollIntoView({
        behavior: "smooth",
        block: "center",
      })
    }

    window.dispatchEvent(
      new CustomEvent(OPEN_REASONING_DRAWER_EVENT, {
        detail: { messageId: message.id },
      })
    )
  }

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

  const exportStatusPinned = pdfExportState !== "idle"
  const actionBarPinned = exportStatusPinned || actionsAlwaysVisible
  const exportStatusLabel =
    pdfExportState === "loading"
      ? "导出中"
      : pdfExportState === "done"
        ? "已导出"
        : pdfExportState === "error"
          ? "导出失败"
          : "导出 PDF"
  const exportStatusClassName = exportStatusPinned
    ? "pointer-events-none absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 rounded-2xl border border-black/10 bg-background/96 px-4 py-1 text-base leading-7 text-foreground opacity-100 shadow-sm backdrop-blur transition-all duration-200 ease-in-out translate-y-0 whitespace-nowrap"
    : "pointer-events-none absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 rounded-2xl border border-black/10 bg-background/96 px-4 py-1 text-base leading-7 text-foreground opacity-0 shadow-sm backdrop-blur transition-all duration-200 ease-in-out group-hover/export-pdf:translate-y-0 group-hover/export-pdf:opacity-100 group-focus-within/export-pdf:translate-y-0 group-focus-within/export-pdf:opacity-100 translate-y-1 whitespace-nowrap"

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
      {!isStreamingAssistant && (onRegenerate || canExportPdf || showSourceSummary) ? (
        <div
          className={cn(
            "mt-2 flex w-full items-center justify-end gap-1 transition-opacity duration-100",
            actionBarPinned
              ? "opacity-100"
              : "opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
          )}
        >
          {onRegenerate ? (
            <div className="group/regenerate relative inline-flex items-center">
              <button
                type="button"
                aria-label="重新生成"
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-100",
                  "hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
                disabled={regenerateDisabled}
                onClick={() => {
                  onRegenerate(message)
                }}
              >
                <RegenerateIcon />
              </button>
              <span className="pointer-events-none absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 rounded-2xl border border-black/10 bg-background/96 px-4 py-1 text-base leading-7 text-foreground opacity-0 shadow-sm backdrop-blur transition-all duration-200 ease-in-out group-hover/regenerate:translate-y-0 group-hover/regenerate:opacity-100 group-focus-within/regenerate:translate-y-0 group-focus-within/regenerate:opacity-100 translate-y-1 whitespace-nowrap">
                重新生成
              </span>
            </div>
          ) : null}
          {canExportPdf ? (
            <div className="group/export-pdf relative inline-flex items-center">
              <span className={exportStatusClassName}>{exportStatusLabel}</span>
              <button
                type="button"
                aria-label="导出 PDF"
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-100",
                  "hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
                disabled={pdfExportState === "loading"}
                onClick={(event) => {
                  void onExportPdf(event)
                }}
              >
                <ExportPdfIcon />
              </button>
            </div>
          ) : null}
          {showSourceSummary ? (
            <button
              type="button"
              aria-label={`${sourceCount} 个来源`}
              className={cn(
                "inline-flex items-center rounded-full border border-foreground/10 bg-secondary/30 px-2.5 py-1 text-sm text-foreground transition-colors",
                "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
              onClick={onOpenReasoningDrawer}
            >
              <span className="truncate">{sourceCount} 个来源</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function TypingIndicator({ elapsedSeconds = 0 }: { elapsedSeconds?: number }) {
  return (
    <div className="flex px-6 py-4">
      <div className="inline-flex items-center gap-2 rounded-full bg-secondary/40 px-3 py-1.5 text-sm text-muted-foreground">
        <span className="inline-flex size-2 rounded-full bg-(--color-claude-warm-gray) animate-pulse" />
        <span className="whitespace-nowrap">{elapsedSeconds > 0 ? `思考中 · ${elapsedSeconds}s` : "思考中"}</span>
      </div>
    </div>
  )
}
