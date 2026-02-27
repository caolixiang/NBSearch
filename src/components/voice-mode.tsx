"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Mic, MicOff, PhoneOff, X } from "lucide-react"
import { GrokLogo } from "./claude-logo"
import { cn } from "@/lib/utils"

interface VoiceModeProps {
  isOpen: boolean
  onClose: () => void
}

export function VoiceMode({ isOpen, onClose }: VoiceModeProps) {
  const [isConnected, setIsConnected] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [isAiSpeaking, setIsAiSpeaking] = useState(false)
  const [duration, setDuration] = useState(0)
  const [connectionStatus, setConnectionStatus] = useState<
    "idle" | "connecting" | "connected"
  >("idle")

  const connect = useCallback(async () => {
    setConnectionStatus("connecting")
    await new Promise((r) => setTimeout(r, 1500))
    setConnectionStatus("connected")
    setIsConnected(true)
    setTimeout(() => setIsAiSpeaking(true), 1000)
    setTimeout(() => setIsAiSpeaking(false), 4000)
  }, [])

  useEffect(() => {
    if (isOpen && !isConnected) {
      connect()
    }
  }, [isOpen, isConnected, connect])

  useEffect(() => {
    if (!isConnected) return
    const interval = setInterval(() => setDuration((d) => d + 1), 1000)
    return () => clearInterval(interval)
  }, [isConnected])

  useEffect(() => {
    if (!isConnected) return
    const interval = setInterval(() => {
      setIsAiSpeaking(true)
      setTimeout(() => setIsAiSpeaking(false), 2000 + Math.random() * 3000)
    }, 8000)
    return () => clearInterval(interval)
  }, [isConnected])

  const handleDisconnect = () => {
    setIsConnected(false)
    setDuration(0)
    setConnectionStatus("idle")
    setIsAiSpeaking(false)
    onClose()
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "size-2 rounded-full",
              isConnected
                ? "bg-green-500"
                : connectionStatus === "connecting"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-muted-foreground"
            )}
          />
          <span className="text-xs text-muted-foreground">
            {connectionStatus === "connecting"
              ? "正在连接..."
              : isConnected
                ? "已连接"
                : "语音对话"}
          </span>
          {isConnected && (
            <span className="text-xs font-mono text-muted-foreground">
              {formatTime(duration)}
            </span>
          )}
        </div>
        <button
          onClick={handleDisconnect}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label="关闭"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Center area */}
      <div className="flex flex-1 flex-col items-center justify-center gap-8">
        {/* Pulsing avatar with rings */}
        <div className="relative">
          {/* Outer ring animation when AI speaking */}
          {isAiSpeaking && (
            <>
              <div className="absolute -inset-6 rounded-full border border-[var(--color-claude-sienna)]/10 animate-[ping_2s_ease-in-out_infinite]" />
              <div className="absolute -inset-4 rounded-full border border-[var(--color-claude-sienna)]/20 animate-[ping_1.5s_ease-in-out_infinite_0.3s]" />
            </>
          )}

          <div
            className={cn(
              "relative flex size-28 items-center justify-center rounded-full transition-all duration-500",
              isAiSpeaking
                ? "bg-[var(--color-claude-sienna)] shadow-[0_0_60px_rgba(196,149,106,0.35)]"
                : "bg-[var(--color-claude-sienna)]/80"
            )}
          >
            <GrokLogo className="size-14 text-white" />
          </div>
        </div>

        {/* Status */}
        <div className="text-center">
          <p className="text-lg font-medium text-foreground">
            {connectionStatus === "connecting"
              ? "正在连接..."
              : isAiSpeaking
                ? "Grok 正在说话"
                : "正在聆听..."}
          </p>
          {isConnected && !isAiSpeaking && (
            <p className="mt-2 text-sm text-muted-foreground">请开始说话</p>
          )}
        </div>

        {/* Audio bars visualization */}
        <AudioBars isActive={isConnected && (isAiSpeaking || !isMuted)} />
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center gap-6 pb-12">
        <button
          className={cn(
            "flex size-14 items-center justify-center rounded-full border border-border transition-colors",
            isMuted
              ? "bg-destructive/10 border-destructive/40 text-destructive"
              : "bg-card text-foreground hover:bg-secondary",
            !isConnected && "opacity-50 pointer-events-none"
          )}
          onClick={() => setIsMuted(!isMuted)}
        >
          {isMuted ? (
            <MicOff className="size-5" />
          ) : (
            <Mic className="size-5" />
          )}
          <span className="sr-only">{isMuted ? "取消静音" : "静音"}</span>
        </button>

        <button
          className="flex size-14 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
          onClick={handleDisconnect}
        >
          <PhoneOff className="size-5" />
          <span className="sr-only">结束通话</span>
        </button>
      </div>
    </div>
  )
}

function AudioBars({
  isActive,
}: {
  isActive: boolean
}) {
  const barsRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<number>(0)

  useEffect(() => {
    const el = barsRef.current
    if (!el) return

    const bars = el.children
    const animate = () => {
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i] as HTMLElement
        if (isActive) {
          const h =
            20 + Math.sin(Date.now() / 150 + i * 0.8) * 30 + Math.random() * 10
          bar.style.height = `${h}%`
          bar.style.opacity = "1"
        } else {
          bar.style.height = "8%"
          bar.style.opacity = "0.3"
        }
      }
      animRef.current = requestAnimationFrame(animate)
    }

    animate()
    return () => cancelAnimationFrame(animRef.current)
  }, [isActive])

  return (
    <div
      ref={barsRef}
      className="flex h-16 items-center justify-center gap-1"
    >
      {Array.from({ length: 24 }).map((_, i) => (
        <div
          key={i}
          className="w-1 rounded-full bg-[var(--color-claude-sienna)] transition-[height] duration-100"
          style={{ height: "8%" }}
        />
      ))}
    </div>
  )
}
