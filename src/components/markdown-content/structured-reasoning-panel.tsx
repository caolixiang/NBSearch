"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Globe, ImageIcon, Search } from "lucide-react"
import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import { cn } from "@/lib/utils"
import {
  buildStructuredReasoningSummary,
  collectRolloutAgents,
  isImageSearchToolName,
  resolveStructuredEntryLabel,
  toAgentKey,
} from "./structured-reasoning"
import { formatSearchTextForDisplay } from "./think-parser"
import { AgentAvatarStack } from "./agent-orbs"

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
  const displayEntries = useMemo(() => {
    if (!effectiveThinking) {
      return summary.entries
    }
    return summary.entries.slice(-3)
  }, [effectiveThinking, summary.entries])
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

  // Sync thinking state: debounce stop to avoid flicker, but ensure consistent cleanup
  useEffect(() => {
    if (effectiveThinkingRaw) {
      // Thinking started or resumed — cancel any pending stop timer
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
      // Thinking stopped — debounce to allow late events
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
      }
      thinkingStopTimerRef.current = window.setTimeout(() => {
        setThinkingStable(false)
        thinkingStopTimerRef.current = null
        // Freeze the final elapsed duration
        if (startedAtRef.current) {
          const elapsed = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000))
          setDurationSeconds(elapsed)
          startedAtRef.current = null
        }
      }, 650)
    }
  }, [effectiveThinkingRaw])

  // Cleanup timers on unmount
  useEffect(
    () => () => {
      if (thinkingStopTimerRef.current) {
        window.clearTimeout(thinkingStopTimerRef.current)
      }
    },
    []
  )

  // Agent rotation timer
  useEffect(() => {
    if (!effectiveThinking || agents.length <= 1) {
      return
    }
    const timer = window.setInterval(() => {
      setActiveTick((value) => value + 1)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, effectiveThinking])

  // Live elapsed second counter — only runs while thinking is active
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

  // Auto-scroll timeline to bottom when new entries arrive during thinking
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
    : (durationSeconds > 0 ? `思考了 ${durationSeconds}s` : "思考了")
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="stroke-[2] shrink-0">
              <path d="M19 9C19 12.866 15.866 17 12 17C8.13398 17 4.99997 12.866 4.99997 9C4.99997 5.13401 8.13398 3 12 3C15.866 3 19 5.13401 19 9Z" className="fill-yellow-100 dark:fill-yellow-300 origin-center" />
              <path d="M15 16.1378L14.487 15.2794L14 15.5705V16.1378H15ZM8.99997 16.1378H9.99997V15.5705L9.51293 15.2794L8.99997 16.1378ZM18 9C18 11.4496 16.5421 14.0513 14.487 15.2794L15.5129 16.9963C18.1877 15.3979 20 12.1352 20 9H18ZM12 4C13.7598 4 15.2728 4.48657 16.3238 5.33011C17.3509 6.15455 18 7.36618 18 9H20C20 6.76783 19.082 4.97946 17.5757 3.77039C16.0931 2.58044 14.1061 2 12 2V4ZM5.99997 9C5.99997 7.36618 6.64903 6.15455 7.67617 5.33011C8.72714 4.48657 10.2401 4 12 4V2C9.89382 2 7.90681 2.58044 6.42427 3.77039C4.91791 4.97946 3.99997 6.76783 3.99997 9H5.99997ZM9.51293 15.2794C7.4578 14.0513 5.99997 11.4496 5.99997 9H3.99997C3.99997 12.1352 5.81225 15.3979 8.48701 16.9963L9.51293 15.2794ZM9.99997 19.5001V16.1378H7.99997V19.5001H9.99997ZM10.5 20.0001C10.2238 20.0001 9.99997 19.7763 9.99997 19.5001H7.99997C7.99997 20.8808 9.11926 22.0001 10.5 22.0001V20.0001ZM13.5 20.0001H10.5V22.0001H13.5V20.0001ZM14 19.5001C14 19.7763 13.7761 20.0001 13.5 20.0001V22.0001C14.8807 22.0001 16 20.8808 16 19.5001H14ZM14 16.1378V19.5001H16V16.1378H14Z" fill="currentColor" />
              <path d="M9 16.0001H15" stroke="currentColor" />
              <path d="M12 16V12" stroke="currentColor" strokeLinecap="square" />
            </svg>
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
              : "max-h-[65vh] overflow-auto pr-2 text-xs text-muted-foreground"
          )}
        >
          {displayEntries.length > 0 ? (
            <div className={cn(effectiveThinking ? "flex flex-col justify-end gap-1.5" : "space-y-2")}>
              {displayEntries.map((entry) => {
                const active =
                  effectiveThinking && entry.status === "running" && toAgentKey(entry.rolloutId) === activeAgentKey
                const isNew = effectiveThinking && newEntryKeys.has(entry.key)
                return (
                  <div
                    key={entry.key}
                    className={cn(
                      "flex items-start justify-between gap-3 py-1",
                      effectiveThinking ? "think-stream-row" : "",
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
                        <p
                          className="truncate text-sm font-medium leading-6 text-foreground"
                        >
                          {formatSearchTextForDisplay(entry.text)}
                        </p>
                      </div>
                    </div>
                    {typeof entry.resultsCount === "number" ? (
                      <span className="inline-flex shrink-0 items-center rounded-md border border-foreground/[0.06] bg-secondary/50 px-1.5 py-0.5 text-[12px] tabular-nums text-muted-foreground">
                        {entry.resultsCount} 结果
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : effectiveThinking ? (
            <div className="space-y-2 pt-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-secondary/70" />
              <div className="h-5 w-full animate-pulse rounded bg-secondary/60" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-secondary/60" />
            </div>
          ) : (
            <p className="pt-2 text-[0.9rem] text-muted-foreground">暂无思考记录</p>
          )}
        </div>
      </div>
    </div>
  )
}
