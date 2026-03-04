"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Globe, ImageIcon, Search, Wrench, X } from "lucide-react"
import { createPortal } from "react-dom"
import type { ChatDeepSearchDetail, ChatReasoningEventDetail } from "@/domain/chat/types"
import { openExternalUrl } from "@/lib/open-external-url"
import { cn } from "@/lib/utils"
import type { StructuredReasoningEntry, StructuredReasoningToolChainItem } from "./types"
import {
  buildStructuredReasoningSummary,
  collectRolloutAgents,
  groupEntriesByAgent,
  isChatroomSendToolName,
  isImageSearchToolName,
  resolveStructuredEntryLabel,
  toAgentKey,
} from "./structured-reasoning"
import type { AgentGroupedEntries } from "./structured-reasoning"
import { formatSearchTextForDisplay } from "./think-parser"
import { AgentAvatarStack, AgentCanvasOrb } from "./agent-orbs"

const OPEN_REASONING_DRAWER_EVENT = "nbsearch:open-reasoning-drawer"

/* ------------------------------------------------------------------ */
/* Entry rendering helpers                                             */
/* ------------------------------------------------------------------ */

function ToolEntryRow({ entry }: { entry: StructuredReasoningEntry }) {
  const [open, setOpen] = useState(false)
  const hasResults = entry.webSearchResults && entry.webSearchResults.length > 0

  const content = (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {hasResults ? (
            <span className="inline-flex size-5 items-center justify-center rounded-full border border-foreground/8 bg-background shadow-sm">
              <ChevronDown className={cn("size-3.5 transition-transform", open ? "rotate-180" : "")} />
            </span>
          ) : entry.visited ? (
            <Globe className="size-4" />
          ) : isImageSearchToolName(entry.toolName) ? (
            <ImageIcon className="size-4" />
          ) : (
            <Search className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {resolveStructuredEntryLabel(entry.toolName, entry.visited, entry.status)}
          </p>
          <p className="truncate text-sm font-medium leading-6 text-foreground">
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
  )

  if (!hasResults) {
    return content
  }

  return (
    <div className="flex flex-col mb-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="w-full rounded-md transition-colors block text-left">
        {content}
      </button>
      {open && (
        <div className="mt-1.5 ml-7 rounded-xl border border-foreground/4 bg-secondary/30 p-3 space-y-3.5">
          {entry.webSearchResults!.map((res, i) => {
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

function ToolChainSection({ toolChain }: { toolChain: StructuredReasoningToolChainItem[] }) {
  if (toolChain.length === 0) {
    return null
  }

  return (
    <section className="mb-4 rounded-xl border border-foreground/6 bg-secondary/20 p-3">
      <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Wrench className="size-3.5" />
        <span>工具链</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {toolChain.map((item) => {
          const statusLabel =
            item.runningCount > 0 ? `进行中 ${item.completedCount}/${item.usageCount}` : `已完成 ${item.usageCount}`
          return (
            <span
              key={item.toolName}
              className="inline-flex items-center gap-1.5 rounded-full border border-foreground/8 bg-background px-2.5 py-1 text-xs"
            >
              <span className="font-medium text-foreground">{item.toolName}</span>
              <span className="text-muted-foreground">{statusLabel}</span>
            </span>
          )
        })}
      </div>
    </section>
  )
}

function DeepSearchDetailSection({ details }: { details: ChatDeepSearchDetail[] }) {
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

/* ------------------------------------------------------------------ */
/* Right-side drawer panel                                             */
/* ------------------------------------------------------------------ */

function ReasoningDrawer({
  agentGroups,
  agents,
  toolChain,
  deepSearchDetails,
  onClose,
}: {
  agentGroups: AgentGroupedEntries[]
  agents: ReturnType<typeof collectRolloutAgents>
  toolChain: StructuredReasoningToolChainItem[]
  deepSearchDetails: ChatDeepSearchDetail[]
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
            <AgentAvatarStack agents={agents} activeAgentKey="" thinking={false} />
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
          <DeepSearchDetailSection details={deepSearchDetails} />
          <ToolChainSection toolChain={toolChain} />
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
  deepSearchDetails = [],
}: {
  messageId?: string
  events: ChatReasoningEventDetail[]
  isThinking: boolean
  isStreaming?: boolean
  durationSeconds?: number
  deepSearchDetails?: ChatDeepSearchDetail[]
}) {
  const summary = useMemo(() => buildStructuredReasoningSummary(events), [events])
  const agents = useMemo(() => collectRolloutAgents(summary.rolloutIds), [summary.rolloutIds])
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

  const hasAgentItems = agents.length > 1
  const durationSuffix = durationSeconds > 0 ? ` ${durationSeconds}s` : ""
  const hasAnyRecords = summary.entries.length > 0 || deepSearchDetails.length > 0
  const toolChainCount = summary.toolChain.length
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
            {toolChainCount > 0 ? ` · ${toolChainCount}个工具` : ""}
          </span>
        </button>
        {drawerOpen && (
          <ReasoningDrawer
            agentGroups={agentGroups}
            agents={agents}
            toolChain={summary.toolChain}
            deepSearchDetails={deepSearchDetails}
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
                            {entry.visited ? (
                              <Globe className="size-4" />
                            ) : isImageSearchToolName(entry.toolName) ? (
                              <ImageIcon className="size-4" />
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
