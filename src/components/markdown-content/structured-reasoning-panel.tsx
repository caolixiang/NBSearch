"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Globe, ImageIcon, Search, X } from "lucide-react"
import { createPortal } from "react-dom"
import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import { cn } from "@/lib/utils"
import type { StructuredReasoningEntry } from "./types"
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

/* ------------------------------------------------------------------ */
/* Entry rendering helpers                                             */
/* ------------------------------------------------------------------ */

function ToolEntryRow({ entry }: { entry: StructuredReasoningEntry }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {entry.visited ? (
            <Globe className="size-4" />
          ) : isImageSearchToolName(entry.toolName) ? (
            <ImageIcon className="size-4" />
          ) : (
            <Search className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-5 text-muted-foreground">
            {resolveStructuredEntryLabel(entry.toolName, entry.visited, entry.status)}
          </p>
          <p className="truncate text-sm font-medium leading-6 text-foreground">
            {formatSearchTextForDisplay(entry.text)}
          </p>
        </div>
      </div>
      {typeof entry.resultsCount === "number" ? (
        <span className="inline-flex shrink-0 items-center rounded-md border border-foreground/[0.06] bg-secondary/50 px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground">
          {entry.resultsCount}
        </span>
      ) : null}
    </div>
  )
}

function ChatroomThinkEntry({ entry }: { entry: StructuredReasoningEntry }) {
  return (
    <div className="py-1.5">
      <p className="rounded-lg border border-foreground/[0.06] bg-secondary/30 px-3.5 py-2.5 text-sm leading-6 text-foreground/80 line-clamp-6 whitespace-pre-wrap">{entry.text}</p>
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
        <div className="mt-1 space-y-0.5 border-l-2 border-foreground/[0.06] pl-3 ml-2">
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

/** Whether any entry in the group is a chatroom / agent-think entry */
function groupHasChatroomEntries(group: AgentGroupedEntries): boolean {
  return group.entries.some((e) => isChatroomSendToolName(e.toolName))
}

/* ------------------------------------------------------------------ */
/* Right-side drawer panel                                             */
/* ------------------------------------------------------------------ */

function ReasoningDrawer({
  agentGroups,
  agents,
  onClose,
}: {
  agentGroups: AgentGroupedEntries[]
  agents: ReturnType<typeof collectRolloutAgents>
  onClose: () => void
}) {
  // Close on Escape
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
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-[100] flex w-full max-w-md flex-col bg-background shadow-2xl border-l border-foreground/[0.06] animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-foreground/[0.06] px-5 py-3.5">
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
        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
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
  events,
  isThinking,
}: {
  events: ChatReasoningEventDetail[]
  isThinking: boolean
}) {
  const summary = useMemo(() => buildStructuredReasoningSummary(events), [events])
  const effectiveThinkingRaw = useMemo(
    () => isThinking || summary.entries.some((entry) => entry.status === "running"),
    [isThinking, summary.entries]
  )
  const [thinkingStable, setThinkingStable] = useState(effectiveThinkingRaw)
  const agents = useMemo(() => collectRolloutAgents(summary.rolloutIds), [summary.rolloutIds])
  const [activeTick, setActiveTick] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const startedAtRef = useRef<number | null>(effectiveThinkingRaw ? Date.now() : null)
  const thinkingStopTimerRef = useRef<number | null>(null)
  const previousEntryCountRef = useRef(summary.entries.length)
  const prevEntryKeysRef = useRef<Set<string>>(new Set(summary.entries.map((e) => e.key)))
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const effectiveThinking = thinkingStable

  // Keep fresh refs so the debounce callback can re-check
  const isThinkingRef = useRef(isThinking)
  isThinkingRef.current = isThinking
  const effectiveThinkingRawRef = useRef(effectiveThinkingRaw)
  effectiveThinkingRawRef.current = effectiveThinkingRaw

  // Entries for the flat FIFO view during thinking
  const displayEntries = useMemo(() => {
    if (!effectiveThinking) {
      return summary.entries
    }
    return summary.entries.slice(-3)
  }, [effectiveThinking, summary.entries])

  // Entries grouped by agent for the drawer
  const agentGroups = useMemo(
    () => groupEntriesByAgent(summary.entries, agents),
    [summary.entries, agents]
  )

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
      if (!entry) {
        continue
      }
      return toAgentKey(entry.rolloutId)
    }
    return "grok_primary"
  }, [summary.entries])

  const activeAgentKey = useMemo(() => {
    if (effectiveThinking) {
      for (let index = summary.entries.length - 1; index >= 0; index -= 1) {
        const entry = summary.entries[index]
        if (!entry || entry.status !== "running") {
          continue
        }
        return toAgentKey(entry.rolloutId)
      }
      if (agents.length > 0) {
        return agents[activeTick % agents.length]?.key || "grok_primary"
      }
      return "grok_primary"
    }
    return latestAgentKey
  }, [activeTick, agents, effectiveThinking, latestAgentKey, summary.entries])

  // Sync thinking state: use longer debounce and re-verify before transitioning
  useEffect(() => {
    if (effectiveThinkingRaw) {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
        thinkingStopTimerRef.current = null
      }
      if (!startedAtRef.current) {
        startedAtRef.current = Date.now()
      }
      setThinkingStable(true)
      setExpanded(true)
    } else {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
      }
      thinkingStopTimerRef.current = window.setTimeout(() => {
        // Re-check with fresh values — if thinking resumed during the debounce, abort transition
        if (isThinkingRef.current || effectiveThinkingRawRef.current) {
          thinkingStopTimerRef.current = null
          return
        }
        setThinkingStable(false)
        setExpanded(false)
        thinkingStopTimerRef.current = null
        if (startedAtRef.current) {
          const elapsed = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000))
          setDurationSeconds(elapsed)
          startedAtRef.current = null
        }
      }, 1500)
    }
  }, [effectiveThinkingRaw])

  useEffect(
    () => () => {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    if (!effectiveThinking || agents.length <= 1) {
      return
    }
    const timer = window.setInterval(() => {
      setActiveTick((value) => value + 1)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, effectiveThinking])

  useEffect(() => {
    if (!effectiveThinking || !startedAtRef.current) {
      return
    }
    const syncElapsed = () => {
      if (!startedAtRef.current) {
        return
      }
      const elapsed = Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
    }
    syncElapsed()
    const timer = window.setInterval(syncElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [effectiveThinking])

  useEffect(() => {
    if (!effectiveThinking) {
      previousEntryCountRef.current = summary.entries.length
      return
    }
    const currentCount = summary.entries.length
    const previousCount = previousEntryCountRef.current
    previousEntryCountRef.current = currentCount
    if (currentCount <= previousCount) {
      return
    }
    const node = timelineRef.current
    if (!node) {
      return
    }
    const raf = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(raf)
  }, [effectiveThinking, summary.entries.length])

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  const hasAgentItems = agents.length > 1
  const durationSuffix = durationSeconds > 0 ? ` ${durationSeconds}s` : ""
  const hasAnyRecords = summary.entries.length > 0
  const showPanel = effectiveThinking || hasAnyRecords

  if (!showPanel) {
    return null
  }

  /* ---- Completed: show lightbulb trigger + side drawer ---- */
  if (!effectiveThinking) {
    return (
      <div className="my-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setDrawerOpen(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="stroke-[2] shrink-0">
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
            onClose={closeDrawer}
          />
        )}
      </div>
    )
  }

  /* ---- Thinking: inline FIFO animation view ---- */
  const thinkingLabel = hasAgentItems ? "代理人思维方式" : `思考中${durationSuffix}`

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-muted-foreground cursor-default"
      >
        <span className="inline-flex items-center gap-1.5">
          <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking />
          <span className="text-sm font-medium whitespace-nowrap text-foreground/80">
            {thinkingLabel}
          </span>
        </span>
      </button>
      <div
        className={cn(
          "transition-all duration-200 ease-out",
          expanded ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0"
        )}
      >
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
                      "flex items-start justify-between gap-3 py-1 think-stream-row",
                      isNew ? "think-stream-row-enter" : "",
                      active ? "think-stream-row-active" : ""
                    )}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                        {entry.visited ? (
                          <Globe className="size-4" />
                        ) : isImageSearchToolName(entry.toolName) ? (
                          <ImageIcon className="size-4" />
                        ) : (
                          <Search className="size-4" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] leading-5 text-muted-foreground">
                          {resolveStructuredEntryLabel(entry.toolName, entry.visited, entry.status)}
                        </p>
                        <p className="truncate text-sm font-medium leading-6 text-foreground">
                          {formatSearchTextForDisplay(entry.text)}
                        </p>
                      </div>
                    </div>
                    {typeof entry.resultsCount === "number" ? (
                      <span className="inline-flex shrink-0 items-center rounded-md border border-foreground/[0.06] bg-secondary/50 px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground">
                        {entry.resultsCount}
                      </span>
                    ) : null}
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
