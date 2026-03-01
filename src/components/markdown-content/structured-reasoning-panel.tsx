"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Globe, ImageIcon, Search } from "lucide-react"
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
/* Agent section for expanded (non-thinking) view                      */
/* ------------------------------------------------------------------ */

function AgentSection({
  agentLabel,
  paletteIndex,
  isPrimary,
  entries,
}: {
  agentLabel: string
  paletteIndex: number
  isPrimary?: boolean
  entries: StructuredReasoningEntry[]
}) {
  const [open, setOpen] = useState(true)

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

  // Entries grouped by agent for the expanded view after thinking
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

  const hasAgentItems = agents.length > 1
  const durationSuffix = durationSeconds > 0 ? ` ${durationSeconds}s` : ""
  const summaryLabel = effectiveThinking
    ? (hasAgentItems ? "代理人思维方式" : `思考中${durationSuffix}`)
    : "思考结果"
  const hasAnyRecords = summary.entries.length > 0
  const showPanel = effectiveThinking || hasAnyRecords
  const bodyExpanded = expanded

  if (!showPanel) {
    return null
  }

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-muted-foreground"
        onClick={() => {
          if (effectiveThinking) {
            return
          }
          setExpanded((value) => !value)
        }}
      >
        <span className="inline-flex items-center gap-1.5">
          {effectiveThinking ? (
            <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={effectiveThinking} />
          ) : (
            <AgentAvatarStack agents={agents} activeAgentKey={latestAgentKey} thinking={false} />
          )}
          <span
            className={cn(
              "text-sm font-medium whitespace-nowrap",
              effectiveThinking ? "text-foreground/80" : "text-muted-foreground"
            )}
          >
            {summaryLabel}
          </span>
        </span>
      </button>
      <div
        className={cn(
          "transition-all duration-200 ease-out",
          bodyExpanded ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0"
        )}
      >
        <div
          ref={timelineRef}
          className={cn(
            effectiveThinking
              ? "relative overflow-hidden"
              : "max-h-[65vh] overflow-auto pr-2"
          )}
        >
          {effectiveThinking ? (
            /* ---- Thinking: flat FIFO animation view ---- */
            displayEntries.length > 0 ? (
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
            )
          ) : (
            /* ---- Completed: agent-grouped view ---- */
            agentGroups.length > 0 ? (
              <div className="space-y-1">
                {agentGroups.map((group, groupIndex) => (
                  <AgentSection
                    key={`${group.agent.key}_${groupIndex}`}
                    agentLabel={group.agent.label}
                    paletteIndex={group.agent.paletteIndex}
                    isPrimary={group.agent.isPrimary}
                    entries={group.entries}
                  />
                ))}
              </div>
            ) : (
              <p className="pt-2 text-[0.9rem] text-muted-foreground">暂无思考记录</p>
            )
          )}
        </div>
      </div>
    </div>
  )
}
