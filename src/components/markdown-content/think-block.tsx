"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Globe, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AssistantToolMeta } from "./types"
import { normalizeAssistantMarkdown } from "./markdown-normalize"
import {
  buildThinkTimeline,
  collectAgentDescriptors,
  findLatestAgentKey,
  formatSearchTextForDisplay,
  parseThinkItems,
} from "./think-parser"
import { AgentAvatarStack, AgentCanvasOrb, AgentIconOrb } from "./agent-orbs"
import { MarkdownBody } from "./markdown-body"

export function ThinkBlock({
  content,
  open,
  thinking,
  toolMeta,
}: {
  content: string
  open: boolean
  thinking: boolean
  toolMeta: AssistantToolMeta
}) {
  const [expanded, setExpanded] = useState(open || thinking)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const [activeTick, setActiveTick] = useState(0)
  const startedAtRef = useRef<number | null>(thinking ? Date.now() : null)
  const previousThinkingRef = useRef(thinking)
  const collapseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (thinking) {
      // Thinking started or resumed — cancel any pending collapse
      if (collapseTimerRef.current) {
        window.clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
      if (!startedAtRef.current) {
        startedAtRef.current = Date.now()
      }
      setExpanded(true)
    } else if (startedAtRef.current) {
      // Thinking stopped — freeze the final elapsed duration and clear ref
      const elapsed = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000))
      setDurationSeconds(elapsed)
      startedAtRef.current = null
    }

    if (previousThinkingRef.current && !thinking) {
      collapseTimerRef.current = window.setTimeout(() => {
        setExpanded(false)
        collapseTimerRef.current = null
      }, 450)
    }
    previousThinkingRef.current = thinking
  }, [thinking])

  // Cleanup timers on unmount
  useEffect(
    () => () => {
      if (collapseTimerRef.current) {
        window.clearTimeout(collapseTimerRef.current)
      }
    },
    []
  )

  const items = useMemo(() => parseThinkItems(content), [content])
  const timeline = useMemo(() => buildThinkTimeline(items, toolMeta), [items, toolMeta])
  const latestTimeline = useMemo(() => timeline.slice(-3), [timeline])
  const displayTimeline = thinking ? latestTimeline : timeline
  const agents = useMemo(() => collectAgentDescriptors(items), [items])
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  const hasAgentItems = agents.length > 0
  const latestAgentKey = useMemo(() => findLatestAgentKey(timeline), [timeline])
  const rotatingAgentKey = agents.length > 0 ? agents[activeTick % agents.length]?.key || "" : ""
  const activeAgentKey = thinking ? rotatingAgentKey || latestAgentKey : latestAgentKey
  const summaryLabel = hasAgentItems ? "代理人思维方式" : thinking ? "思考中" : "思考"
  const durationLabel = durationSeconds > 0 || thinking ? ` · ${durationSeconds || 0}s` : ""
  const containerClassName = thinking ? "text-xs text-muted-foreground" : "max-h-[65vh] overflow-auto pr-2 text-xs text-muted-foreground"

  // Live elapsed second counter — only runs while thinking is active AND startedAtRef is set
  useEffect(() => {
    if (!thinking || !startedAtRef.current) {
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
  }, [thinking])

  // Agent rotation timer
  useEffect(() => {
    if (!thinking || agents.length <= 1) {
      return
    }

    const timer = window.setInterval(() => {
      setActiveTick((value) => value + 1)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [agents.length, thinking])

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-2.5 text-muted-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/85 transition-transform duration-200",
            expanded ? "rotate-90" : ""
          )}
        />
        {hasAgentItems ? (
          <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={thinking} />
        ) : (
          <span
            className={cn(
              "inline-flex h-4 w-4 shrink-0 rounded-full bg-[conic-gradient(from_180deg,#f59e0b,#f97316,#22c55e,#0ea5e9,#f59e0b)]",
              thinking ? "think-summary-active" : ""
            )}
          />
        )}
        <span className="text-[0.92rem] font-medium text-muted-foreground">
          {summaryLabel}
          {durationLabel}
        </span>
      </button>

      <div
        className={cn(
          "transition-all duration-200 ease-out",
          expanded ? "mt-2 opacity-100" : "max-h-0 overflow-hidden opacity-0",
          !thinking && expanded ? "max-h-[65vh]" : ""
        )}
      >
        <div className={containerClassName}>
          {!thinking && expanded && hasAgentItems ? (
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AgentAvatarStack agents={agents} activeAgentKey={activeAgentKey} thinking={false} />
                <h4 className="text-[0.95rem] font-medium text-foreground">思考结果</h4>
              </div>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                onClick={() => setExpanded(false)}
                aria-label="关闭思考结果"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : null}
          {displayTimeline.length > 0 ? (
            <div className="space-y-3">
              {displayTimeline.map((entry, index) => {
                if (entry.kind === "websearch") {
                  return (
                    <div key={entry.key} className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                          {entry.visited ? <Globe className="size-5" /> : <Search className="size-5" />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[0.95rem] text-muted-foreground">
                            {entry.visited ? "已浏览" : "已搜索的网络"}
                          </p>
                          <p
                            className={cn(
                              thinking
                                ? "break-all text-[0.95rem] leading-6 text-foreground"
                                : "break-all text-base leading-8 text-foreground",
                              entry.visited ? "italic" : ""
                            )}
                          >
                            {formatSearchTextForDisplay(entry.text)}
                          </p>
                        </div>
                      </div>
                      {typeof entry.resultsCount === "number" ? (
                        <span className="shrink-0 pt-1 text-[0.95rem] text-muted-foreground">
                          {entry.resultsCount} 结果
                        </span>
                      ) : null}
                    </div>
                  )
                }

                if (entry.kind === "agent") {
                  const active = thinking && entry.agentKey === activeAgentKey
                  const isPrimaryAgent = entry.agentKey === "grok_primary"
                  return (
                    <div key={entry.key} className="space-y-2.5">
                      <div className="flex items-center gap-2 pl-0.5 text-[0.95rem] font-semibold text-foreground">
                        {isPrimaryAgent ? (
                          <AgentCanvasOrb paletteIndex={0} isPrimary={true} active={active} thinking={thinking} size="lg" />
                        ) : (
                          <AgentIconOrb
                            paletteIndex={entry.paletteIndex}
                            active={active}
                            thinking={thinking}
                            size="lg"
                          />
                        )}
                        <span>{entry.agentLabel}</span>
                        <ChevronDown className="size-4 text-muted-foreground" />
                      </div>
                      <p
                        className={cn(
                          "ml-11 whitespace-pre-wrap break-words text-[0.92rem] leading-6 text-foreground/95",
                          thinking
                            ? "[display:-webkit-box] [-webkit-line-clamp:4] [-webkit-box-orient:vertical] overflow-hidden"
                            : ""
                        )}
                      >
                        {entry.body || "（空）"}
                      </p>
                    </div>
                  )
                }

                return (
                  <div key={entry.key} className="space-y-1">
                    <p className="text-[0.9rem] font-medium text-muted-foreground">{entry.label}</p>
                    {entry.body.trim() ? (
                      <p className="whitespace-pre-wrap text-[0.95rem] leading-7 text-foreground/95">
                        {entry.body}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : thinking ? (
            <div className="space-y-2 pt-1">
              <div className="h-3 w-2/5 animate-pulse rounded bg-secondary/70" />
              <div className="h-5 w-full animate-pulse rounded bg-secondary/60" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-secondary/60" />
            </div>
          ) : (
            <MarkdownBody content={normalized || "（空）"} />
          )}
        </div>
      </div>
    </div>
  )
}
