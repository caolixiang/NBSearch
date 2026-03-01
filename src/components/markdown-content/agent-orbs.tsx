"use client"

import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { cn } from "@/lib/utils"
import type { AgentDescriptor } from "./types"
import { AGENT_PIXEL_PALETTES, AGENT_STACK_RING_COLORS } from "./types"

export function AgentCanvasOrb({
  paletteIndex,
  active,
  thinking,
  size = "md",
  isPrimary = false,
}: {
  paletteIndex: number
  active: boolean
  thinking: boolean
  size?: "sm" | "md" | "lg"
  isPrimary?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const tickRef = useRef(0)

  // Grok uses golden angle to distribute base hues. If it's the primary agent, use Grok's signature red/orange.
  const baseHue = useMemo(() => (isPrimary ? 12 : (137.508 * (paletteIndex + 1)) % 360), [paletteIndex, isPrimary])

  // Draw smooth organic blobs to canvas
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, time: number) => {
      const w = 64
      const h = 64
      ctx.clearRect(0, 0, w, h)
      
      // Draw a base background
      const baseGrad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w/2)
      baseGrad.addColorStop(0, `hsl(${baseHue}, 85%, 55%)`)
      baseGrad.addColorStop(1, `hsl(${(baseHue + 40) % 360}, 90%, 35%)`)
      ctx.fillStyle = baseGrad
      ctx.fillRect(0, 0, w, h)

      // Only animate internal blobs if "thinking"
      const t = thinking ? time * 0.002 : 0

      // Draw 3 moving "blobs" of color to create the organic fluid effect
      const blobs = [
        { hueOff: -30, size: 28, x: w/2 + Math.sin(t * 1.2) * 12, y: h/2 + Math.cos(t * 1.3) * 12 },
        { hueOff: 45,  size: 32, x: w/2 + Math.sin(t * 1.5 + 2) * 14, y: h/2 + Math.cos(t * 1.1 + 3) * 14 },
        { hueOff: 15,  size: 24, x: w/2 + Math.cos(t * 0.9 + 4) * 16, y: h/2 + Math.sin(t * 1.4 + 1) * 16 }
      ]

      // Set global composite operation for smooth blending
      ctx.globalCompositeOperation = 'screen'

      blobs.forEach(blob => {
        const grad = ctx.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, blob.size)
        grad.addColorStop(0, `hsla(${(baseHue + blob.hueOff + 360) % 360}, 90%, 65%, 0.8)`)
        grad.addColorStop(1, `hsla(${(baseHue + blob.hueOff + 360) % 360}, 90%, 65%, 0)`)
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)
      })

      ctx.globalCompositeOperation = 'source-over'
    },
    [baseHue, thinking]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    
    // Apply blur filter on the 64x64 canvas for ultra-smoothness
    ctx.filter = 'blur(6px)'

    if (thinking) {
      const loop = () => {
        tickRef.current += 16
        draw(ctx, tickRef.current)
        rafRef.current = requestAnimationFrame(loop)
      }
      loop()
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
      }
    } else {
      draw(ctx, 0)
    }
  }, [draw, thinking])

  const pxSize = size === "sm" ? 18 : size === "lg" ? 28 : 20

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full shadow-[inset_0_1px_3px_rgba(255,255,255,0.3)]",
        active ? "ring-2 ring-foreground/20 ring-offset-2 ring-offset-background" : ""
      )}
      style={{ width: pxSize, height: pxSize }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        width={64}
        height={64}
        style={{
          width: pxSize,
          height: pxSize,
          imageRendering: "auto" as const, // explicitly use smooth rendering
        }}
        className="scale-125" // Scale up slightly to hide blurred edges
      />
    </span>
  )
}

export function AgentIconOrb({
  paletteIndex,
  active,
  thinking,
  size = "md",
  animationDelayMs = 0,
}: {
  paletteIndex: number
  active: boolean
  thinking: boolean
  size?: "sm" | "md" | "lg"
  animationDelayMs?: number
}) {
  const ringColor = AGENT_STACK_RING_COLORS[Math.abs(paletteIndex) % AGENT_STACK_RING_COLORS.length]
  const shellStyle = {
    animationDelay: `${animationDelayMs}ms`,
    borderColor: ringColor,
  } as const

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        active ? "think-grok-orb" : ""
      )}
      aria-hidden="true"
    >
      {active ? <span className="absolute -inset-[2.5px] rounded-full think-agent-active-halo" /> : null}
      <AgentCanvasOrb
        paletteIndex={paletteIndex}
        active={active}
        thinking={thinking}
        size={size}
      />
    </span>
  )
}

// Removed GrokPrimaryOrb. Replaced with AgentCanvasOrb usage.

export function AgentAvatarStack({
  agents,
  activeAgentKey,
  thinking,
}: {
  agents: AgentDescriptor[]
  activeAgentKey: string
  thinking: boolean
}) {
  const visibleAgents = agents.slice(0, 5)

  return (
    <span className="inline-flex items-center -space-x-1.5">
      {visibleAgents.map((agent, index) =>
        agent.isPrimary ? (
          <AgentCanvasOrb key={agent.key} paletteIndex={0} isPrimary={true} active={agent.key === activeAgentKey} thinking={thinking} size="sm" />
        ) : (
          <AgentIconOrb
            key={agent.key}
            paletteIndex={agent.paletteIndex}
            active={agent.key === activeAgentKey}
            thinking={thinking}
            size="sm"
            animationDelayMs={index * 130}
          />
        )
      )}
      {agents.length > visibleAgents.length ? (
        <span className="ml-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border bg-background px-1 text-[10px] font-medium text-muted-foreground">
          +{agents.length - visibleAgents.length}
        </span>
      ) : null}
    </span>
  )
}
