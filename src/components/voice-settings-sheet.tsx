"use client"

import { useEffect, useMemo, useState, type FormEvent } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Armchair,
  Atom,
  Bot,
  BookOpen,
  Flame,
  HeartHandshake,
  Mountain,
  Settings2,
  Stethoscope,
  Trophy,
  Zap,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

const VOICE_OPTIONS = [
  { id: "ara", label: "Ara", subtitle: "Upbeat Female" },
  { id: "eve", label: "Eve", subtitle: "Soothing Female" },
  { id: "leo", label: "Leo", subtitle: "British Male" },
  { id: "rex", label: "Rex", subtitle: "Calm Male" },
  { id: "sal", label: "Sal", subtitle: "Smooth Male" },
  { id: "gork", label: "Gork", subtitle: "Lazy Male" },
] as const

interface PersonalityOption {
  id: string
  label: string
  icon: LucideIcon
  badge?: string
}

const PERSONALITY_OPTIONS: readonly PersonalityOption[] = [
  { id: "custom", label: "自定义", icon: Settings2 },
  { id: "assistant", label: "Assistant", icon: Bot },
  { id: "therapist", label: '"Therapist"', icon: Armchair },
  { id: "storyteller", label: "Storyteller", icon: BookOpen },
  { id: "kids_story", label: "Kids Story Time", icon: Trophy },
  { id: "kids_trivia", label: "Kids Trivia Game", icon: Trophy },
  { id: "meditation", label: "Meditation", icon: Mountain },
  { id: "doc", label: 'Grok "Doc"', icon: Stethoscope },
  { id: "unhinged", label: "Unhinged", icon: Atom, badge: "18+" },
  { id: "sexy", label: "Sexy", icon: Flame, badge: "18+" },
  { id: "motivation", label: "Motivation", icon: Zap, badge: "18+" },
  { id: "conspiracy", label: "Conspiracy", icon: Atom },
  { id: "romantic", label: "Romantic", icon: HeartHandshake, badge: "18+" },
  { id: "argumentative", label: "Argumentative", icon: Zap, badge: "18+" },
] as const

const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const
const SPEED_DOT_COUNT = 16

export type VoiceOptionId = (typeof VOICE_OPTIONS)[number]["id"]
export type VoicePersonalityId = (typeof PERSONALITY_OPTIONS)[number]["id"]

export function getVoiceOptionLabel(voiceId: string): string {
  return VOICE_OPTIONS.find((option) => option.id === voiceId)?.label || "Leo"
}

function formatSpeed(value: number): string {
  return value.toFixed(2).replace(/\.00$/, ".0")
}

interface VoiceSettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedVoiceId: VoiceOptionId
  onSelectVoice: (voiceId: VoiceOptionId) => void
  selectedPersonalityId: VoicePersonalityId
  onSelectPersonality: (personalityId: VoicePersonalityId) => void
  customPrompt: string
  onSaveCustomPrompt: (prompt: string) => void
  speed: number
  onSpeedChange: (speed: number) => void
}

function SectionTitle({ children }: { children: string }) {
  return <p className="px-1 text-[11px] font-semibold tracking-[0.08em] text-foreground/80">{children}</p>
}

function PersonalityCard({
  icon: Icon,
  label,
  badge,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  badge?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-w-[7.75rem] shrink-0 flex-col items-start gap-2 rounded-2xl border px-3 py-3 text-left transition-colors",
        active
          ? "border-foreground/10 bg-secondary text-foreground shadow-[0_8px_20px_-18px_rgba(15,23,42,0.8)]"
          : "border-border/80 bg-background hover:bg-secondary/45"
      )}
    >
      <Icon className="size-[18px] text-foreground" />
      <p className="min-w-[94px] text-sm font-medium leading-5 text-foreground">
        <span>{label}</span>
        {badge ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{badge}</span> : null}
      </p>
    </button>
  )
}

function SpeedControl({ speed, onSpeedChange }: { speed: number; onSpeedChange: (speed: number) => void }) {
  const normalizedSpeed = useMemo(() => {
    return SPEED_STEPS.reduce((currentBest, currentValue) => {
      const currentDistance = Math.abs(currentValue - speed)
      const bestDistance = Math.abs(currentBest - speed)
      return currentDistance < bestDistance ? currentValue : currentBest
    }, SPEED_STEPS[0])
  }, [speed])

  const selectedSpeedIndex = Math.max(0, SPEED_STEPS.indexOf(normalizedSpeed))
  const selectedPercent = (selectedSpeedIndex / (SPEED_STEPS.length - 1)) * 100

  return (
    <div className="mt-3 flex items-center gap-3">
      <div className="relative flex h-11 flex-1 items-center overflow-hidden rounded-[28px] border border-border/80 bg-secondary/25 px-3 shadow-inner">
        <div
          className="absolute inset-y-1 left-1 rounded-full bg-foreground transition-[width] duration-200"
          style={{ width: `calc(${selectedPercent}% + 2rem)` }}
        />
        <div className="pointer-events-none absolute inset-x-4 top-1/2 z-10 flex -translate-y-1/2 items-center justify-between">
          {Array.from({ length: SPEED_DOT_COUNT }).map((_, index) => (
            <span
              key={index}
              className={cn(
                "size-1 rounded-full transition-colors",
                index / (SPEED_DOT_COUNT - 1) <= selectedPercent / 100 ? "bg-background/60" : "bg-foreground/16"
              )}
            />
          ))}
        </div>
        <div className="relative z-20 h-full w-full">
          {SPEED_STEPS.map((option, index) => {
            const active = option === normalizedSpeed
            const percent = (index / (SPEED_STEPS.length - 1)) * 100
            return (
              <button
                key={option}
                type="button"
                onClick={() => onSpeedChange(option)}
                aria-label={`语速 ${formatSpeed(option)}x`}
                aria-pressed={active}
                className="absolute top-1/2 flex size-8 -translate-y-1/2 -translate-x-1/2 items-center justify-center"
                style={{ left: `${percent}%` }}
              >
                {active ? <span className="size-5 rounded-full bg-background shadow-sm" /> : null}
              </button>
            )
          })}
        </div>
      </div>
      <span className="w-10 text-right text-sm font-semibold tabular-nums text-foreground">{formatSpeed(normalizedSpeed)}x</span>
    </div>
  )
}

export function VoiceSettingsSheet({
  open,
  onOpenChange,
  selectedVoiceId,
  onSelectVoice,
  selectedPersonalityId,
  onSelectPersonality,
  customPrompt,
  onSaveCustomPrompt,
  speed,
  onSpeedChange,
}: VoiceSettingsSheetProps) {
  const [draftPrompt, setDraftPrompt] = useState(customPrompt)

  useEffect(() => {
    if (open) {
      setDraftPrompt(customPrompt)
    }
  }, [customPrompt, open])

  const saveDisabled = draftPrompt.trim() === customPrompt.trim()

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSelectPersonality("custom")
    onSaveCustomPrompt(draftPrompt.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-auto bottom-2 left-1/2 grid h-auto min-h-[33rem] max-h-[90dvh] w-[min(28rem,calc(100%-0.75rem))] translate-x-[-50%] translate-y-0 gap-0 overflow-hidden rounded-[24px] border border-border/80 bg-background p-0 shadow-[0_-16px_48px_-24px_rgba(15,23,42,0.45)] sm:bottom-4 sm:max-w-none"
      >
        <DialogTitle className="sr-only">语音设置</DialogTitle>
        <DialogDescription className="sr-only">选择声音、个性化风格和播放速度</DialogDescription>

        <div className="overflow-y-auto px-4 pb-4 pt-3 sm:px-5">
          <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-muted-foreground/25" />

          <section>
            <SectionTitle>声音</SectionTitle>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {VOICE_OPTIONS.map((voice) => {
                const active = voice.id === selectedVoiceId
                return (
                  <button
                    key={voice.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelectVoice(voice.id)}
                    className={cn(
                      "flex min-h-[92px] flex-col items-start rounded-2xl border px-3 py-3 text-left transition-colors",
                      active
                        ? "border-foreground/10 bg-secondary text-foreground shadow-[0_8px_20px_-18px_rgba(15,23,42,0.8)]"
                        : "border-border/80 bg-background hover:bg-secondary/45"
                    )}
                  >
                    <p className="text-[15px] font-semibold leading-5 text-foreground">{voice.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{voice.subtitle}</p>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="mt-5">
            <SectionTitle>个性化</SectionTitle>
            <div className="-mx-1 mt-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex gap-2 pr-1">
                {PERSONALITY_OPTIONS.map((option) => (
                  <PersonalityCard
                    key={option.id}
                    icon={option.icon}
                    label={option.label}
                    badge={option.badge}
                    active={option.id === selectedPersonalityId}
                    onClick={() => onSelectPersonality(option.id)}
                  />
                ))}
              </div>
            </div>

            <form
              onSubmit={handleSave}
              className="mt-3 rounded-[20px] border border-border/80 bg-background px-4 py-4 shadow-sm"
            >
              <p className="text-sm font-medium text-foreground">说明</p>
              <textarea
                value={draftPrompt}
                onChange={(event) => setDraftPrompt(event.target.value)}
                placeholder="请描述你希望 Grok 采用的行为、语气和回应方式。"
                className="mt-3 min-h-[112px] w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="submit"
                  disabled={saveDisabled}
                  className={cn(
                    "inline-flex h-9 items-center justify-center rounded-full px-4 text-xs font-semibold transition-colors",
                    saveDisabled
                      ? "cursor-not-allowed bg-secondary text-muted-foreground"
                      : "bg-foreground text-background hover:opacity-90"
                  )}
                >
                  保存
                </button>
              </div>
            </form>
          </section>

          <section className="mt-5">
            <div className="flex items-center justify-between gap-3 px-1">
              <SectionTitle>速度</SectionTitle>
            </div>
            <SpeedControl speed={speed} onSpeedChange={onSpeedChange} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
