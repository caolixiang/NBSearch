"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Brain, Check, ChevronDown, Sparkles, Zap } from "lucide-react"
import type { ModelOption } from "@/domain/models/types"
import {
  buildQuickModelPresets,
  resolveQuickModelPresetId,
  shouldCollapseQuickModelSwitch,
  type QuickModelPresetId,
} from "@/features/chat/model-selection"
import { cn } from "@/lib/utils"

interface ChatInputQuickModelSwitchProps {
  models: ModelOption[]
  selectedModel: string
  onModelChange: (modelId: string) => void
  inputValue: string
  attachmentCount: number
  disabled?: boolean
}

function QuickPresetIcon({ presetId, className }: { presetId: QuickModelPresetId; className?: string }) {
  switch (presetId) {
    case "fast":
      return <Zap className={className} />
    case "thinker":
      return <Brain className={className} />
    case "max":
      return <Sparkles className={className} />
  }
}

export function ChatInputQuickModelSwitch({
  models,
  selectedModel,
  onModelChange,
  inputValue,
  attachmentCount,
  disabled = false,
}: ChatInputQuickModelSwitchProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const presets = useMemo(() => buildQuickModelPresets(models, selectedModel), [models, selectedModel])
  const activePresetId = useMemo(
    () => resolveQuickModelPresetId(models, selectedModel),
    [models, selectedModel]
  )
  const activePreset =
    presets.find((preset) => preset.id === activePresetId) ||
    presets.find((preset) => preset.modelId === selectedModel) ||
    presets[0]
  const collapsed = shouldCollapseQuickModelSwitch(inputValue, attachmentCount)

  useEffect(() => {
    if (!isOpen) {
      return
    }
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handlePointerDown)
    return () => document.removeEventListener("mousedown", handlePointerDown)
  }, [isOpen])

  useEffect(() => {
    if (disabled) {
      setIsOpen(false)
    }
  }, [disabled])

  if (!activePreset || presets.length === 0) {
    return null
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          if (disabled) {
            return
          }
          setIsOpen((previous) => !previous)
        }}
        className={cn(
          "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent text-foreground transition-colors duration-100 hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
          collapsed ? "size-10 px-0" : "h-10 px-3.5 pe-2 text-sm font-semibold"
        )}
        aria-label="模型快捷切换"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={disabled}
      >
        {collapsed ? (
          <QuickPresetIcon presetId={activePreset.id} className="size-4.5" />
        ) : (
          <>
            <span className="line-clamp-1 shrink-0">{activePreset.label}</span>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
          </>
        )}
      </button>

      {isOpen ? (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-30 mb-2 min-w-[220px] overflow-hidden rounded-2xl border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/5"
        >
          {presets.map((preset) => {
            const selected = preset.id === activePreset.id
            return (
              <button
                key={preset.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onModelChange(preset.modelId)
                  setIsOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
                  selected ? "bg-secondary/80" : "hover:bg-secondary/70"
                )}
              >
                <div
                  className={cn(
                    "flex size-[18px] shrink-0 items-center justify-center",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <QuickPresetIcon presetId={preset.id} className="size-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-1 text-sm font-semibold text-foreground">{preset.label}</div>
                  <div className="line-clamp-1 text-xs text-muted-foreground">{preset.description}</div>
                </div>
                <Check className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
