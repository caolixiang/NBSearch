"use client"

import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check, Zap, Brain, Sparkles, Cpu } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ModelOption {
  id: string
  name: string
  shortName: string
  provider: string
  description: string
  icon: React.ReactNode
}

export const MODELS: ModelOption[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    shortName: "Sonnet 4.5",
    provider: "Anthropic",
    description: "智能与速度的最佳平衡",
    icon: <Zap className="size-4" />,
  },
  {
    id: "anthropic/claude-opus-4-1",
    name: "Claude Opus 4.1",
    shortName: "Opus 4.1",
    provider: "Anthropic",
    description: "最强推理能力",
    icon: <Brain className="size-4" />,
  },
  {
    id: "grok-4.1-fast",
    name: "Grok 4.1 Fast",
    shortName: "Grok 4.1",
    provider: "Gateway",
    description: "低延迟会话模式",
    icon: <Sparkles className="size-4" />,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    shortName: "GPT-5 Mini",
    provider: "Gateway",
    description: "快速且高效",
    icon: <Cpu className="size-4" />,
  },
]

interface ModelSelectorProps {
  selectedModel: string
  onModelChange: (modelId: string) => void
}

export function ModelSelector({
  selectedModel,
  onModelChange,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = MODELS.find((m) => m.id === selectedModel) || MODELS[0]

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
        <span>{selected.shortName}</span>
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
            {MODELS.map((model) => (
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
                  {model.icon}
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
  )
}
