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
import {
  VOICE_SPEED_STEPS,
  formatVoiceSpeed,
  normalizeVoiceSpeed,
} from "@/components/voice-settings-speed"
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

export type VoiceOptionId = (typeof VOICE_OPTIONS)[number]["id"]
export type VoicePersonalityId = (typeof PERSONALITY_OPTIONS)[number]["id"]

export function getVoiceOptionLabel(voiceId: string): string {
  return VOICE_OPTIONS.find((option) => option.id === voiceId)?.label || "Leo"
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
  return <p className="px-2 py-2 text-xs font-semibold text-foreground">{children}</p>
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
          ? "border-foreground/10 bg-secondary text-foreground"
          : "border-border bg-background hover:bg-secondary/40"
      )}
    >
      <Icon className="size-[18px] text-foreground" />
      <p className="min-w-[96px] text-sm font-medium leading-5 text-foreground">
        <span>{label}</span>
        {badge ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{badge}</span> : null}
      </p>
    </button>
  )
}

function SpeedControl({ speed, onSpeedChange }: { speed: number; onSpeedChange: (speed: number) => void }) {
  const normalizedSpeed = useMemo(() => normalizeVoiceSpeed(speed), [speed])

  const selectedSpeedIndex = Math.max(0, VOICE_SPEED_STEPS.indexOf(normalizedSpeed))
  const selectedPercent = (selectedSpeedIndex / (VOICE_SPEED_STEPS.length - 1)) * 100

  return (
    <div className="mt-2 flex items-center gap-3 px-2">
      <div className="relative flex h-10 flex-1 items-center overflow-hidden rounded-[32px] border border-border bg-background p-1">
        <div className="absolute inset-1 rounded-full bg-background" />
        <div className="absolute inset-y-[3px] left-1 right-1 overflow-hidden rounded-s-full">
          <div
            className="absolute inset-y-0 left-0 rounded-s-full bg-foreground transition-[right] duration-200"
            style={{ right: `${100 - selectedPercent}%` }}
          />
        </div>
        <div className="pointer-events-none absolute inset-x-3 top-1/2 z-10 flex -translate-y-1/2 items-center justify-between">
          {VOICE_SPEED_STEPS.map((option, index) => (
            <span
              key={option}
              className={cn(
                "size-1 rounded-full transition-colors",
                index <= selectedSpeedIndex
                  ? "bg-background/55"
                  : "bg-foreground/18"
              )}
            />
          ))}
        </div>
        <div className="relative z-20 h-full w-full">
          {VOICE_SPEED_STEPS.map((option, index) => {
            const active = option === normalizedSpeed
            const percent = (index / (VOICE_SPEED_STEPS.length - 1)) * 100
            return (
              <button
                key={option}
                type="button"
                onClick={() => onSpeedChange(option)}
                aria-label={`语速 ${formatVoiceSpeed(option)}x`}
                aria-pressed={active}
                className="absolute top-1/2 flex size-8 -translate-y-1/2 -translate-x-1/2 items-center justify-center focus-visible:outline-none"
                style={{ left: `${percent}%` }}
              >
                {active ? (
                  <span className="relative flex h-[2.15rem] w-8 items-center justify-center">
                    <span className="absolute inset-0 rounded-e-full bg-foreground" />
                    <span className="relative z-10 size-5 rounded-full bg-background shadow-[0_1px_4px_rgba(15,23,42,0.18)]" />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
      <span className="w-10 text-right text-sm font-semibold tabular-nums text-foreground">{formatVoiceSpeed(normalizedSpeed)}x</span>
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
        className="top-auto bottom-2 left-1/2 grid h-auto min-h-[34rem] max-h-[90dvh] w-[min(30rem,calc(100%-0.5rem))] translate-x-[-50%] translate-y-0 gap-0 overflow-hidden rounded-[24px] border border-border bg-card/98 p-0 shadow-[0_-16px_40px_-28px_rgba(15,23,42,0.35)] backdrop-blur-sm sm:bottom-3 sm:max-w-none"
      >
        <DialogTitle className="sr-only">语音设置</DialogTitle>
        <DialogDescription className="sr-only">选择声音、个性化风格和播放速度</DialogDescription>

        <div className="overflow-y-auto px-3 pb-3 pt-3 sm:px-4">
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-muted-foreground/25" />

          <section>
            <SectionTitle>声音</SectionTitle>
            <div className="grid grid-cols-3 gap-2 px-2">
              {VOICE_OPTIONS.map((voice) => {
                const active = voice.id === selectedVoiceId
                return (
                  <button
                    key={voice.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelectVoice(voice.id)}
                    className={cn(
                      "flex min-h-[88px] flex-col items-start rounded-2xl border px-3 py-3 text-left transition-colors",
                      active
                        ? "border-foreground/10 bg-secondary text-foreground"
                        : "border-border bg-background hover:bg-secondary/40"
                    )}
                  >
                    <p className="text-[15px] font-semibold leading-5 text-foreground">{voice.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{voice.subtitle}</p>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="mt-3">
            <SectionTitle>个性化</SectionTitle>
            <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex gap-2 px-1">
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

            <form onSubmit={handleSave} className="mt-2.5 rounded-xl border border-border bg-background px-3 py-3">
              <p className="text-sm font-medium text-foreground">说明</p>
              <textarea
                value={draftPrompt}
                onChange={(event) => setDraftPrompt(event.target.value)}
                placeholder="请描述你希望 Grok 采用的行为、语气和回应方式。"
                className="mt-2.5 min-h-[108px] w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={saveDisabled}
                  className={cn(
                    "inline-flex h-8 items-center justify-center rounded-full px-3 text-xs font-semibold transition-colors",
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

          <section className="mt-3">
            <div className="flex items-center justify-between pr-1">
              <SectionTitle>速度</SectionTitle>
            </div>
            <SpeedControl speed={speed} onSpeedChange={onSpeedChange} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
