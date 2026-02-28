"use client"

import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check, Zap, Brain, Sparkles, Cpu, RotateCw, Bot } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ModelOption } from "@/domain/models/types"

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

interface ModelSelectorProps {
  models: ModelOption[]
  selectedModel: string
  onModelChange: (modelId: string) => void
  onRefresh?: () => void
  isRefreshing?: boolean
}

export function ModelSelector({
  models,
  selectedModel,
  onModelChange,
  onRefresh,
  isRefreshing = false,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = models.find((m) => m.id === selectedModel) || models[0]

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
          <span>{selected?.shortName || "选择模型"}</span>
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
                      ? "bg-[var(--color-claude-sienna)]/10"
                      : "hover:bg-secondary"
                  )}
                >
                  <div
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      model.id === selectedModel
                        ? "bg-[var(--color-claude-sienna)]/15 text-[var(--color-claude-sienna)]"
                        : "bg-secondary text-muted-foreground"
                    )}
                  >
                    {renderModelIcon(model)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {model.name}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {model.description}
                    </p>
                  </div>
                  {model.id === selectedModel && (
                    <Check className="size-4 shrink-0 text-[var(--color-claude-sienna)]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {onRefresh ? (
        <button
          type="button"
          onClick={() => onRefresh()}
          disabled={isRefreshing}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="刷新模型列表"
          title="刷新模型列表"
        >
          <RotateCw className={cn("size-4", isRefreshing && "animate-spin")} />
        </button>
      ) : null}
    </div>
  )
}
