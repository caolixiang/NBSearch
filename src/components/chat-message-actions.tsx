import type { MouseEvent } from "react"
import { cn } from "@/lib/utils"

function RegenerateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 12a9 9 0 0 1 15.36-6.36L21 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 3v5h-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 12a9 9 0 0 1-15.36 6.36L3 16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 21v-5h5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ExportPdfIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 19h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ChatMessageActionBar({
  onRegenerate,
  regenerateDisabled,
  onExportPdf,
  canExportPdf,
  pdfExportState,
  actionsAlwaysVisible,
  hidePdfExport,
  showSourceSummary,
  sourceCount,
  onOpenReasoningDrawer,
}: {
  onRegenerate?: () => void
  regenerateDisabled: boolean
  onExportPdf: (event: MouseEvent<HTMLButtonElement>) => void
  canExportPdf: boolean
  pdfExportState: "idle" | "loading" | "done" | "error"
  actionsAlwaysVisible: boolean
  hidePdfExport: boolean
  showSourceSummary: boolean
  sourceCount: number
  onOpenReasoningDrawer: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  if (!onRegenerate && !canExportPdf && !showSourceSummary) {
    return null
  }

  const exportStatusPinned = pdfExportState !== "idle"
  const actionBarPinned = exportStatusPinned || actionsAlwaysVisible
  const rightAlignActionBar = hidePdfExport
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
    <div
      className={cn(
        "mt-2 flex w-full items-center gap-1 transition-opacity duration-100",
        rightAlignActionBar ? "justify-end" : "justify-start",
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
            onClick={onRegenerate}
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
            onClick={onExportPdf}
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
  )
}
