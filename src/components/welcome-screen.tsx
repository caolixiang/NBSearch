"use client"

import { GrokAvatar } from "./claude-logo"

export function WelcomeScreen() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <GrokAvatar size="lg" className="size-20" />
      <h1 className="mt-5 text-2xl font-semibold text-foreground text-balance text-center">
        有什么我可以帮助你的？
      </h1>
    </div>
  )
}
