"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Globe, Lightbulb, Search, UserRound, X } from "lucide-react"
import { createPortal } from "react-dom"
import type { ChatDeepSearchResearch, ChatDeepSearchDetail, ChatReasoningEventDetail } from "@/domain/chat/types"
import { openExternalUrl } from "@/lib/open-external-url"
import { cn } from "@/lib/utils"
import type { StructuredReasoningEntry } from "./types"
import {
  buildDeepSearchLegacyTimeline,
  buildDeepSearchTimeline,
  buildStructuredReasoningSummary,
  collectRolloutAgents,
  groupEntriesByAgent,
  hasDeepSearchContent,
  isChatroomSendToolName,
  isImageSearchToolName,
  isXSearchToolName,
  mergeReasoningRolloutIds,
  resolveStructuredEntryLabel,
  shouldShowResearchDetails,
  toAgentKey,
} from "./structured-reasoning"
import type { AgentGroupedEntries, DeepSearchTimelineItem } from "./structured-reasoning"
import { formatSearchTextForDisplay } from "./think-parser"
import { AgentAvatarStack, AgentCanvasOrb } from "./agent-orbs"

const OPEN_REASONING_DRAWER_EVENT = "nbsearch:open-reasoning-drawer"

function XBrandIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path
        d="M18.244 2.25H21.552L14.325 10.51L22.827 21.75H16.17L10.956 14.933L4.99 21.75H1.68L9.41 12.915L1.254 2.25H8.08L12.793 8.481L18.244 2.25ZM17.083 19.77H18.916L7.084 4.126H5.117L17.083 19.77Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ImageSearchToolIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M12 10C13.1046 10 14 10.8954 14 12C14 13.1046 13.1046 14 12 14C10.8954 14 10 13.1046 10 12C10 10.8954 10.8954 10 12 10Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M12.2002 6C13.0237 6 13.7016 5.99898 14.252 6.04395C14.814 6.08987 15.3311 6.18827 15.8164 6.43555C16.5689 6.81902 17.181 7.43109 17.5645 8.18359C17.8117 8.6689 17.9101 9.18599 17.9561 9.74805C18.001 10.2984 18 10.9763 18 11.7998V16.2002C18 17.0237 18.001 17.7016 17.9561 18.252C17.9101 18.814 17.8117 19.3311 17.5645 19.8164C17.181 20.5689 16.5689 21.181 15.8164 21.5645C15.3311 21.8117 14.814 21.9101 14.252 21.9561C13.7016 22.001 13.0237 22 12.2002 22H7.79981C6.97632 22 6.29843 22.001 5.74805 21.9561C5.18599 21.9101 4.6689 21.8117 4.1836 21.5645C3.43109 21.181 2.81902 20.5689 2.43555 19.8164C2.18827 19.3311 2.08988 18.814 2.04395 18.252C1.99898 17.7016 2 17.0237 2 16.2002V11.7998C2 10.9763 1.99898 10.2984 2.04395 9.74805C2.08988 9.18599 2.18827 8.6689 2.43555 8.18359C2.81902 7.43109 3.43109 6.81902 4.1836 6.43555C4.6689 6.18827 5.18599 6.08987 5.74805 6.04395C6.29843 5.99898 6.97632 6 7.79981 6H12.2002ZM4.02735 17.9287C4.03066 17.9839 4.0329 18.0373 4.03711 18.0889C4.07293 18.5273 4.13809 18.7518 4.21778 18.9082C4.40951 19.2845 4.71555 19.5905 5.0918 19.7822C5.2482 19.8619 5.47272 19.9271 5.91113 19.9629C6.36117 19.9997 6.94342 20 7.79981 20H10.8262L6.89844 15.417L4.02735 17.9287ZM7.79981 8C6.94342 8 6.36117 8.00035 5.91113 8.03711C5.47272 8.07293 5.2482 8.13808 5.0918 8.21777C4.71555 8.40951 4.40951 8.71554 4.21778 9.0918C4.13809 9.2482 4.07293 9.47272 4.03711 9.91113C4.00035 10.3612 4 10.9434 4 11.7998V15.2959L7.10156 12.582L13.4512 19.9912C13.6932 19.9859 13.9024 19.9781 14.0889 19.9629C14.5273 19.9271 14.7518 19.8619 14.9082 19.7822C15.2845 19.5905 15.5905 19.2845 15.7822 18.9082C15.8619 18.7518 15.9271 18.5273 15.9629 18.0889C15.9997 17.6388 16 17.0566 16 16.2002V11.7998C16 10.9434 15.9997 10.3612 15.9629 9.91113C15.9271 9.47272 15.8619 9.2482 15.7822 9.0918C15.5905 8.71554 15.2845 8.40951 14.9082 8.21777C14.7518 8.13808 14.5273 8.07293 14.0889 8.03711C13.6388 8.00035 13.0566 8 12.2002 8H7.79981Z" fill="currentColor" />
      <path d="M22 16C22 17.1046 21.1046 18 20 18V14H22V16Z" fill="currentColor" />
      <path d="M22 12H20V8H22V12Z" fill="currentColor" />
      <path d="M18.252 2.04395C18.814 2.08987 19.3311 2.18827 19.8164 2.43555C20.5689 2.81902 21.181 3.43109 21.5645 4.18359C21.8117 4.6689 21.9101 5.18599 21.9561 5.74805C21.9627 5.8292 21.9659 5.91325 21.9707 6H19.9678C19.9657 5.96984 19.9653 5.94015 19.9629 5.91113C19.9271 5.47272 19.8619 5.2482 19.7822 5.0918C19.5905 4.71554 19.2845 4.40951 18.9082 4.21777C18.7518 4.13808 18.5273 4.07293 18.0889 4.03711C18.0598 4.03474 18.0302 4.03333 18 4.03125V2.02832C18.0868 2.0331 18.1708 2.03731 18.252 2.04395Z" fill="currentColor" />
      <path d="M10 4H6C6 2.89543 6.89543 2 8 2H10V4Z" fill="currentColor" />
      <path d="M16 4H12V2H16V4Z" fill="currentColor" />
    </svg>
  )
}

function formatRelativeTimeLabel(value: string | undefined): string {
  const source = (value || "").trim()
  if (!source) {
    return ""
  }
  const millis = Date.parse(source)
  if (!Number.isFinite(millis)) {
    return ""
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - millis) / 1000))
  if (diffSeconds < 60) {
    return `${diffSeconds}s`
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m`
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h`
  }
  return `${Math.floor(diffSeconds / 86400)}d`
}

function buildXSearchUrl(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return ""
  }
  return `https://x.com/search?q=${encodeURIComponent(trimmed)}&src=typed_query&f=live`
}

/* ------------------------------------------------------------------ */
/* Entry rendering helpers                                             */
/* ------------------------------------------------------------------ */

function ToolEntryRow({ entry }: { entry: StructuredReasoningEntry }) {
  const [open, setOpen] = useState(false)
  const resultRows = Array.isArray(entry.webSearchResults) ? entry.webSearchResults : []
  const hasResults = resultRows.length > 0
  const isXSearch = isXSearchToolName(entry.toolName)
  const displayText = formatSearchTextForDisplay(entry.text)
  const xSearchUrl = isXSearch ? buildXSearchUrl(displayText) : ""
  const canExpand = hasResults || (isXSearch && Boolean(xSearchUrl))
  const displayResultsCount =
    typeof entry.resultsCount === "number" ? entry.resultsCount : hasResults ? resultRows.length : isXSearch ? 0 : undefined

  const content = (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {isXSearch ? (
            <XBrandIcon className="size-4" />
          ) : hasResults ? (
            <span className="inline-flex size-5 items-center justify-center rounded-full border border-foreground/8 bg-background shadow-sm">
              <ChevronDown className={cn("size-3.5 transition-transform", open ? "rotate-180" : "")} />
            </span>
          ) : entry.visited ? (
            <Globe className="size-4" />
          ) : isImageSearchToolName(entry.toolName) ? (
            <ImageSearchToolIcon className="size-4" />
          ) : (
            <Search className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {resolveStructuredEntryLabel(entry.toolName, entry.visited, entry.status)}
          </p>
          <p className="truncate text-sm font-medium leading-6 text-foreground">
            {displayText}
          </p>
        </div>
      </div>
      {typeof displayResultsCount === "number" ? (
        <span className="inline-flex shrink-0 items-center rounded-md border border-foreground/6 bg-secondary/50 px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground">
          {displayResultsCount}
        </span>
      ) : null}
    </div>
  )

  if (!canExpand) {
    return content
  }

  return (
    <div className="flex flex-col mb-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="w-full rounded-md transition-colors block text-left">
        {content}
      </button>
      {open && (
        <>
          {isXSearch ? (
            <div className="mt-1.5 ml-7 overflow-hidden rounded-xl border border-foreground/8 bg-background/40 divide-y divide-foreground/8">
              {resultRows.map((res, i) => {
                const authorName = (res.authorName || "").trim() || "X 用户"
                const authorHandle = (res.authorHandle || "").trim()
                const postText = (res.preview || "").trim() || (res.title || "").trim() || (res.url || "").trim()
                const timeLabel = formatRelativeTimeLabel(res.publishedAt)
                const clickable = Boolean((res.url || "").trim())
                return (
                  <button
                    key={i}
                    type="button"
                    className={cn(
                      "group block w-full px-4 py-3 text-left transition-colors",
                      clickable ? "cursor-pointer hover:bg-secondary/35" : "cursor-default"
                    )}
                    onClick={() => {
                      if (res.url) {
                        void openExternalUrl(res.url)
                      }
                    }}
                  >
                    <span className="flex items-start gap-2.5">
                      <span className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-foreground/8 bg-background/80 text-muted-foreground">
                        <UserRound className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-[15px] font-semibold leading-5 text-foreground">
                              {authorName}
                            </span>
                            {authorHandle ? (
                              <span className="block truncate text-[13px] leading-5 text-muted-foreground">
                                @{authorHandle}
                              </span>
                            ) : null}
                          </span>
                          {timeLabel ? (
                            <span className="shrink-0 text-[12px] leading-5 text-muted-foreground tabular-nums">
                              {timeLabel}
                            </span>
                          ) : null}
                        </span>
                        {postText ? (
                          <p className="mt-2 text-sm leading-6 text-foreground whitespace-pre-wrap break-words">
                            {postText}
                          </p>
                        ) : null}
                      </span>
                    </span>
                  </button>
                )
              })}
              {!hasResults && xSearchUrl ? (
                <button
                  type="button"
                  className="group block w-full px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-secondary/35"
                  onClick={() => {
                    void openExternalUrl(xSearchUrl)
                  }}
                >
                  在 X 中查看“{displayText}”
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-1.5 ml-7 rounded-xl border border-foreground/4 bg-secondary/30 p-3 space-y-3.5">
              {resultRows.map((res, i) => {
                let host = ""
                try {
                  if (res.url) host = new URL(res.url).host.replace(/^www\./, "")
                } catch {
                  host = res.url || ""
                }
                return (
                  <div key={i} className="flex flex-col gap-1">
                    <a
                      href={res.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] font-bold text-foreground hover:underline line-clamp-2 leading-snug"
                      onClick={(event) => {
                        event.preventDefault()
                        if (res.url) {
                          void openExternalUrl(res.url)
                        }
                      }}
                    >
                      {res.title || res.url}
                    </a>
                    {res.url && (
                      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/80">
                        {res.favicon ? (
                          <img src={res.favicon} alt="" className="size-3.5 rounded-sm bg-background/50 object-cover shrink-0" />
                        ) : (
                          <Globe className="size-3.5 shrink-0" />
                        )}
                        <span className="truncate">{host}</span>
                      </div>
                    )}
                    {res.preview && (
                      <p className="text-[12px] text-muted-foreground/90 line-clamp-2 mt-0.5 leading-[1.6]">{res.preview}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ChatroomThinkEntry({ entry, clamp }: { entry: StructuredReasoningEntry, clamp?: boolean }) {
  return (
    <div className="py-1.5">
      <div className="rounded-lg border border-foreground/6 bg-secondary/30 px-3.5 py-2.5 text-sm leading-6 text-foreground/80 whitespace-pre-wrap">
        <div className={cn("wrap-break-word break-all", clamp ? "line-clamp-2" : "")}>{entry.text}</div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Agent section                                                       */
/* ------------------------------------------------------------------ */

function AgentSection({
  agentLabel,
  paletteIndex,
  isPrimary,
  entries,
  defaultOpen,
}: {
  agentLabel: string
  paletteIndex: number
  isPrimary?: boolean
  entries: StructuredReasoningEntry[]
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="mb-3">
      <button
        type="button"
        className="inline-flex items-center gap-2 text-sm font-medium text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <AgentCanvasOrb paletteIndex={paletteIndex} active={false} thinking={false} size="sm" isPrimary={isPrimary} />
        <span>{isPrimary ? `${agentLabel} 领导者` : agentLabel}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open ? "" : "-rotate-90"
          )}
        />
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 border-l-2 border-foreground/6 pl-3 ml-2">
          {entries.map((entry) =>
            isChatroomSendToolName(entry.toolName) ? (
              <ChatroomThinkEntry key={entry.key} entry={entry} />
            ) : (
              <ToolEntryRow key={entry.key} entry={entry} />
            )
          )}
        </div>
      )}
    </div>
  )
}

function groupHasChatroomEntries(group: AgentGroupedEntries): boolean {
  return group.entries.some((e) => isChatroomSendToolName(e.toolName))
}

function ResearchDetailSection({ details }: { details: ChatDeepSearchDetail[] }) {
  if (details.length === 0) {
    return null
  }

  return (
    <section className="mb-4 space-y-2.5">
      {details.map((detail, index) => (
        <article key={`${detail.title}-${index}`} className="rounded-xl border border-foreground/8 bg-secondary/20 p-3">
          <h4 className="text-[15px] font-semibold leading-6 text-foreground">{detail.title}</h4>
          {detail.bullets.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px] leading-6 text-foreground/80">
              {detail.bullets.map((row, rowIndex) => (
                <li key={`${detail.title}-${rowIndex}`} className="break-words">
                  {row}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </section>
  )
}

function ResearchTimelineSection({ items }: { items: DeepSearchTimelineItem[] }) {
  if (items.length === 0) {
    return null
  }

  return (
    <section className="mb-4">
      {items.map((item, index) =>
        item.kind === "thought" ? (
          <details key={item.key} open={index === 0} className="group border-b border-foreground/8">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-left text-[15px] font-semibold text-foreground">
              <Lightbulb className="size-4 shrink-0 text-muted-foreground group-open:text-foreground" />
              <span className="line-clamp-2 break-words">{item.title}</span>
              <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            {item.bullets.length > 0 ? (
              <ul className="list-disc space-y-2 pl-8 pb-3 text-[14px] leading-6 text-foreground/80">
                {item.bullets.map((row, rowIndex) => (
                  <li key={`${item.key}-${rowIndex}`} className="break-words">
                    {row}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        ) : (
          <div key={item.key} className="border-b border-foreground/8 py-1">
            <ToolEntryRow entry={item.entry} />
          </div>
        )
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Right-side drawer panel                                             */
/* ------------------------------------------------------------------ */

function ReasoningDrawer({
  agentGroups,
  agents,
  researchTimeline,
  researchDetails,
  showResearchDetails,
  onClose,
}: {
  agentGroups: AgentGroupedEntries[]
  agents: ReturnType<typeof collectRolloutAgents>
  researchTimeline: DeepSearchTimelineItem[]
  researchDetails: ChatDeepSearchDetail[]
  showResearchDetails: boolean
  onClose: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onClose])

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-90 bg-black/20 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 z-100 flex w-full max-w-md flex-col bg-background shadow-2xl border-l border-foreground/6 animate-in slide-in-from-right duration-200">
        <div className="flex items-center justify-between border-b border-foreground/6 px-5 py-3.5">
          <div className="inline-flex items-center gap-2">
            {researchTimeline.length > 0 ? null : (
              <AgentAvatarStack agents={agents} activeAgentKey="" thinking={false} />
            )}
            <span className="text-base font-semibold text-foreground">思考结果</span>
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {researchTimeline.length > 0 ? (
            <ResearchTimelineSection items={researchTimeline} />
          ) : (
            <>
              {showResearchDetails ? <ResearchDetailSection details={researchDetails} /> : null}
              {agentGroups.length > 0 ? (
                <div className="space-y-1">
                  {agentGroups.map((group, groupIndex) => (
                    <AgentSection
                      key={`${group.agent.key}_${groupIndex}`}
                      agentLabel={group.agent.label}
                      paletteIndex={group.agent.paletteIndex}
                      isPrimary={group.agent.isPrimary}
                      entries={group.entries}
                      defaultOpen={groupHasChatroomEntries(group)}
                    />
                  ))}
                </div>
              ) : (
                <p className="pt-2 text-[0.9rem] text-muted-foreground">暂无思考记录</p>
              )}
            </>
          )}
        </div>
      </div>
    </>,
    document.body
  )
}

/* ------------------------------------------------------------------ */
/* Main panel                                                          */
/* ------------------------------------------------------------------ */

export function StructuredReasoningPanel({
  messageId,
  events,
  isThinking,
  isStreaming = false,
  durationSeconds = 0,
  researchData,
}: {
  messageId?: string
  events: ChatReasoningEventDetail[]
  isThinking: boolean
  isStreaming?: boolean
  durationSeconds?: number
  researchData?: ChatDeepSearchResearch
}) {
  const summary = useMemo(() => buildStructuredReasoningSummary(events), [events])
  const researchSteps = researchData?.steps || []
  const researchDetails = researchData?.details || []
  const mergedRolloutIds = useMemo(
    () => mergeReasoningRolloutIds(summary.rolloutIds, researchData),
    [researchData?.uiLayout?.rolloutIds, summary.rolloutIds]
  )
  const agents = useMemo(() => collectRolloutAgents(mergedRolloutIds), [mergedRolloutIds])
  const hasAgentItems = agents.length > 1
  const useResearchTimelineView = hasDeepSearchContent(researchData) && !hasAgentItems
  const researchTimeline = useMemo(
    () => {
      if (!useResearchTimelineView) {
        return []
      }
      return researchSteps.length > 0
        ? buildDeepSearchTimeline(researchSteps, summary.entries)
        : buildDeepSearchLegacyTimeline(researchDetails, summary.entries)
    },
    [researchDetails, researchSteps, summary.entries, useResearchTimelineView]
  )
  const [activeTick, setActiveTick] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const previousEntryCountRef = useRef(summary.entries.length)
  const prevEntryKeysRef = useRef<Set<string>>(new Set(summary.entries.map((e) => e.key)))
  const timelineRef = useRef<HTMLDivElement | null>(null)

  // ---- Thinking state ----
  // "Thinking" should track active reasoning only.
  // Keep historical entries visible after thinking stops, but freeze the timer.
  const hasReasoningActivity = isThinking || summary.entries.some((e) => e.status === "running")
  const effectiveThinking = isStreaming && hasReasoningActivity

  // FIFO entries for the thinking animation view
  const displayEntries = useMemo(
    () => (effectiveThinking ? summary.entries.slice(-3) : summary.entries),
    [effectiveThinking, summary.entries]
  )

  // Agent-grouped entries for the drawer
  const agentGroups = useMemo(
    () => groupEntriesByAgent(summary.entries, agents),
    [summary.entries, agents]
  )

  // New entry detection for animation
  const newEntryKeys = useMemo(() => {
    const currentKeys = new Set(displayEntries.map((e) => e.key))
    const prevKeys = prevEntryKeysRef.current
    const added = new Set<string>()
    for (const key of currentKeys) {
      if (!prevKeys.has(key)) {
        added.add(key)
      }
    }
    prevEntryKeysRef.current = currentKeys
    return added
  }, [displayEntries])

  const latestAgentKey = useMemo(() => {
    for (let index = summary.entries.length - 1; index >= 0; index -= 1) {
      const entry = summary.entries[index]
      if (entry) return toAgentKey(entry.rolloutId)
    }
    return "grok_primary"
  }, [summary.entries])

  const activeAgentKey = useMemo(() => {
    if (effectiveThinking) {
      for (let index = summary.entries.length - 1; index >= 0; index -= 1) {
        const entry = summary.entries[index]
        if (entry?.status === "running") return toAgentKey(entry.rolloutId)
      }
      if (agents.length > 0) return agents[activeTick % agents.length]?.key || "grok_primary"
      return "grok_primary"
    }
    return latestAgentKey
  }, [activeTick, agents, effectiveThinking, latestAgentKey, summary.entries])

  // Agent rotation timer
  useEffect(() => {
    if (!effectiveThinking || agents.length <= 1) return
    const timer = window.setInterval(() => setActiveTick((v) => v + 1), 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, effectiveThinking])

  // Auto-scroll timeline during thinking
  useEffect(() => {
    if (!effectiveThinking) {
      previousEntryCountRef.current = summary.entries.length
      return
    }
    const currentCount = summary.entries.length
    if (currentCount <= previousEntryCountRef.current) {
      previousEntryCountRef.current = currentCount
      return
    }
    previousEntryCountRef.current = currentCount
    const node = timelineRef.current
    if (!node) return
    const raf = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(raf)
  }, [effectiveThinking, summary.entries.length])

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const durationSuffix = durationSeconds > 0 ? ` ${durationSeconds}s` : ""
  const showResearchDetails = shouldShowResearchDetails(hasAgentItems, researchTimeline.length)
  const hasAnyRecords =
    summary.entries.length > 0 || researchTimeline.length > 0 || (showResearchDetails && researchDetails.length > 0)
  const showPanel = effectiveThinking || hasAnyRecords

  useEffect(() => {
    const onOpenDrawer = (event: Event) => {
      const customEvent = event as CustomEvent<{ messageId?: string }>
      const targetMessageId = (customEvent.detail?.messageId || "").trim()
      const currentMessageId = (messageId || "").trim()
      if (targetMessageId && currentMessageId && targetMessageId !== currentMessageId) {
        return
      }
      if (!hasAnyRecords || effectiveThinking) {
        return
      }
      setDrawerOpen(true)
    }

    window.addEventListener(OPEN_REASONING_DRAWER_EVENT, onOpenDrawer)
    return () => {
      window.removeEventListener(OPEN_REASONING_DRAWER_EVENT, onOpenDrawer)
    }
  }, [effectiveThinking, hasAnyRecords, messageId])

  if (!showPanel) {
    return null
  }

  /* ---- Completed: lightbulb trigger → side drawer ---- */
  if (!effectiveThinking) {
    return (
      <div id={messageId ? `reasoning-panel-${messageId}` : undefined} className="my-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setDrawerOpen(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="stroke-2 shrink-0">
            <path d="M19 9C19 12.866 15.866 17 12 17C8.13398 17 4.99997 12.866 4.99997 9C4.99997 5.13401 8.13398 3 12 3C15.866 3 19 5.13401 19 9Z" className="fill-yellow-100 dark:fill-yellow-300 origin-center" />
            <path d="M15 16.1378L14.487 15.2794L14 15.5705V16.1378H15ZM8.99997 16.1378H9.99997V15.5705L9.51293 15.2794L8.99997 16.1378ZM18 9C18 11.4496 16.5421 14.0513 14.487 15.2794L15.5129 16.9963C18.1877 15.3979 20 12.1352 20 9H18ZM12 4C13.7598 4 15.2728 4.48657 16.3238 5.33011C17.3509 6.15455 18 7.36618 18 9H20C20 6.76783 19.082 4.97946 17.5757 3.77039C16.0931 2.58044 14.1061 2 12 2V4ZM5.99997 9C5.99997 7.36618 6.64903 6.15455 7.67617 5.33011C8.72714 4.48657 10.2401 4 12 4V2C9.89382 2 7.90681 2.58044 6.42427 3.77039C4.91791 4.97946 3.99997 6.76783 3.99997 9H5.99997ZM9.51293 15.2794C7.4578 14.0513 5.99997 11.4496 5.99997 9H3.99997C3.99997 12.1352 5.81225 15.3979 8.48701 16.9963L9.51293 15.2794ZM9.99997 19.5001V16.1378H7.99997V19.5001H9.99997ZM10.5 20.0001C10.2238 20.0001 9.99997 19.7763 9.99997 19.5001H7.99997C7.99997 20.8808 9.11926 22.0001 10.5 22.0001V20.0001ZM13.5 20.0001H10.5V22.0001H13.5V20.0001ZM14 19.5001C14 19.7763 13.7761 20.0001 13.5 20.0001V22.0001C14.8807 22.0001 16 20.8808 16 19.5001H14ZM14 16.1378V19.5001H16V16.1378H14Z" fill="currentColor" />
            <path d="M9 16.0001H15" stroke="currentColor" />
            <path d="M12 16V12" stroke="currentColor" strokeLinecap="square" />
          </svg>
          <span className="text-sm font-medium whitespace-nowrap">
            {durationSeconds > 0 ? `思考了 ${durationSeconds}s` : "思考了"}
          </span>
        </button>
        {drawerOpen && (
          <ReasoningDrawer
            agentGroups={agentGroups}
            agents={agents}
            researchTimeline={researchTimeline}
            researchDetails={researchDetails}
            showResearchDetails={showResearchDetails}
            onClose={closeDrawer}
          />
        )}
      </div>
    )
  }

  /* ---- Thinking: inline FIFO animation view ---- */
  const thinkingLabel = hasAgentItems ? `代理人协作思考中${durationSuffix}` : `思考中${durationSuffix}`

  return (
    <div id={messageId ? `reasoning-panel-${messageId}` : undefined} className="my-2 w-full">
      <span className="inline-flex items-center gap-1.5 cursor-default">
        <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking />
        <span className="text-sm font-medium whitespace-nowrap text-foreground/80">
          {thinkingLabel}
        </span>
      </span>
      <div className="mt-2">
        <div ref={timelineRef} className="relative overflow-hidden">
          {displayEntries.length > 0 ? (
            <div className="flex flex-col justify-end gap-1.5">
              {displayEntries.map((entry) => {
                const active =
                  entry.status === "running" && toAgentKey(entry.rolloutId) === activeAgentKey
                const isNew = newEntryKeys.has(entry.key)
                return (
                  <div
                    key={entry.key}
                    className={cn(
                      "flex flex-col gap-1 py-1 think-stream-row",
                      isNew ? "think-stream-row-enter" : "",
                      active ? "think-stream-row-active" : ""
                    )}
                  >
                    {isChatroomSendToolName(entry.toolName) ? (
                      <ChatroomThinkEntry entry={entry} clamp={true} />
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-1 items-start gap-2.5">
                          <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                            {isXSearchToolName(entry.toolName) ? (
                              <XBrandIcon className="size-4" />
                            ) : entry.visited ? (
                              <Globe className="size-4" />
                            ) : isImageSearchToolName(entry.toolName) ? (
                              <ImageSearchToolIcon className="size-4" />
                            ) : (
                              <Search className="size-4" />
                            )}
                          </span>
                          <div className="min-w-0 flex-1 text-left">
                            <p className="truncate text-[13px] leading-5 text-muted-foreground">
                              {resolveStructuredEntryLabel(entry.toolName, entry.visited, entry.status)}
                            </p>
                            <p className="text-sm font-medium leading-6 text-foreground wrap-break-word whitespace-pre-wrap">
                              {formatSearchTextForDisplay(entry.text)}
                            </p>
                          </div>
                        </div>
                        {typeof entry.resultsCount === "number" ? (
                          <span className="inline-flex shrink-0 items-center rounded-md border border-foreground/6 bg-secondary/50 px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground">
                            {entry.resultsCount}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-2 pt-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-secondary/70" />
              <div className="h-5 w-full animate-pulse rounded bg-secondary/60" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-secondary/60" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
