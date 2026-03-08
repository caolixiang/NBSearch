"use client"

import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check, Zap, Brain, Sparkles, Cpu, Bot } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ModelOption } from "@/domain/models/types"

function resolveModelDisplayName(model: ModelOption): string {
  const id = model.id.trim().toLowerCase()
  const name = model.name.trim().toLowerCase()

  if (id.includes("grok-4.1-fast") || name.includes("grok 4.1 fast")) {
    return "NBSearch Fast"
  }
  if (id.includes("grok-4.1-expert") || name.includes("grok 4.1 expert")) {
    return "NBSearch Thinker"
  }
  if (
    id.includes("grok-4.20") ||
    id.includes("grok-4-20") ||
    name.includes("grok 4.20 beta")
  ) {
    return "NBSearch Max"
  }
  return model.name
}

function resolveModelDisplayShortName(model: ModelOption): string {
  const displayName = resolveModelDisplayName(model)
  return displayName || model.shortName || model.name
}

function renderModelIcon(model: ModelOption): React.ReactNode {
  switch (model.visualKind) {
    case "speed":
      return <Zap className="size-4" />
    case "reasoning":
      return <Brain className="size-4" />
    case "spark":
      return <Sparkles className="size-4" />
    case "compute":
      return <Cpu className="size-4" />
    default:
      return <Bot className="size-4" />
  }
}

function SyncGatewayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 12V19M12 19L9.75 16.6667M12 19L14.25 16.6667M6.6 17.8333C4.61178 17.8333 3 16.1917 3 14.1667C3 12.498 4.09438 11.0897 5.59198 10.6457C5.65562 10.6268 5.7 10.5675 5.7 10.5C5.7 7.46243 8.11766 5 11.1 5C14.0823 5 16.5 7.46243 16.5 10.5C16.5 10.5582 16.5536 10.6014 16.6094 10.5887C16.8638 10.5306 17.1284 10.5 17.4 10.5C19.3882 10.5 21 12.1416 21 14.1667C21 16.1917 19.3882 17.8333 17.4 17.8333"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

interface ModelSelectorProps {
  models: ModelOption[]
  selectedModel: string
  onModelChange: (modelId: string) => void
  onRefresh?: () => void
  isRefreshing?: boolean
  refreshStatusMessage?: string
  refreshStatusTone?: "success" | "error"
}

export function ModelSelector({
  models,
  selectedModel,
  onModelChange,
  onRefresh,
  isRefreshing = false,
  refreshStatusMessage,
  refreshStatusTone = "success",
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = models.find((model) => model.id === selectedModel) || models[0]

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div className="flex items-center gap-2">
      <div className="relative" ref={ref}>
        {/* Trigger - model name with chevron */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "flex items-center gap-1 rounded-lg px-2 py-1.5 text-base font-semibold transition-colors",
            "text-foreground hover:bg-secondary",
            isOpen && "bg-secondary"
          )}
        >
          <span>{selected ? resolveModelDisplayShortName(selected) : "选择模型"}</span>
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              isOpen && "rotate-180"
            )}
          />
        </button>

        {/* Dropdown - opens downward */}
        {isOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <div className="p-1.5">
              {models.map((model) => (
                <button
                  key={model.id}
                  onClick={() => {
                    onModelChange(model.id)
                    setIsOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    model.id === selectedModel
                      ? "bg-claude-sienna/10"
                      : "hover:bg-secondary"
                  )}
                >
                  <div
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      model.id === selectedModel
                        ? "bg-claude-sienna/15 text-claude-sienna"
                        : "bg-secondary text-muted-foreground"
                    )}
                  >
                    {renderModelIcon(model)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {resolveModelDisplayName(model)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {model.description}
                    </p>
                  </div>
                  {model.id === selectedModel && (
                    <Check className="size-4 shrink-0 text-claude-sienna" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {onRefresh ? (
        <>
          <button
            type="button"
            onClick={() => onRefresh()}
            disabled={isRefreshing}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="同步网关模型"
            title="同步网关模型"
          >
            <SyncGatewayIcon className={cn("size-4", isRefreshing && "animate-pulse")} />
          </button>
          {refreshStatusMessage ? (
            <span
              className={cn(
                "text-xs",
                refreshStatusTone === "success"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-destructive"
              )}
            >
              {refreshStatusMessage}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
