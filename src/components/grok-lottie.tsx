"use client"

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLottie } from "lottie-react"
import {
  folderLottieData,
  imageLottieData,
  pinLottieData,
  rewindLottieData,
  searchLottieData,
  squareCodeLottieData,
  squarePenLottieData,
  waveformLottieData,
} from "./grok-official-lottie-data"

type HoverAnimationContextValue = {
  isHovering: boolean
}

const HoverAnimationContext = createContext<HoverAnimationContextValue>({
  isHovering: false,
})

export function HoverAnimationProvider({
  value,
  children,
}: {
  value: HoverAnimationContextValue
  children: ReactNode
}) {
  return <HoverAnimationContext.Provider value={value}>{children}</HoverAnimationContext.Provider>
}

function useDebouncedValue(value: boolean, delay = 100): boolean {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])

  return debounced
}

const LOTTIE_DATA = {
  search: searchLottieData,
  waveform: waveformLottieData,
  folder: folderLottieData,
  pin: pinLottieData,
  image: imageLottieData,
  rewind: rewindLottieData,
  square_code: squareCodeLottieData,
  square_pen: squarePenLottieData,
} as const

export type GrokLottieName = keyof typeof LOTTIE_DATA

export function GrokLottieIcon({
  name,
  size = 24,
  className,
  loop = false,
}: {
  name: GrokLottieName
  size?: number
  className?: string
  loop?: boolean
}) {
  const animationData = LOTTIE_DATA[name]
  const { isHovering } = useContext(HoverAnimationContext)
  const debouncedHover = useDebouncedValue(isHovering, 80)

  const { View, play, goToAndStop, animationLoaded } = useLottie(
    {
      animationData,
      loop,
      autoplay: false,
      className,
      renderer: "canvas",
    },
    {
      width: size,
      height: size,
    }
  )

  const startedRef = useRef(false)
  const playRef = useRef(play)
  const stopRef = useRef(goToAndStop)
  const previousHoverRef = useRef(debouncedHover)

  playRef.current = play
  stopRef.current = goToAndStop

  useEffect(() => {
    if (!animationLoaded || startedRef.current) {
      return
    }
    startedRef.current = true
    stopRef.current(0, true)
  }, [animationLoaded, name])

  useEffect(() => {
    const previousHover = previousHoverRef.current
    previousHoverRef.current = debouncedHover
    if (!animationLoaded || !debouncedHover || previousHover) {
      return
    }
    stopRef.current(0, true)
    playRef.current()
  }, [animationLoaded, debouncedHover])

  return <div style={{ width: size, height: size }}>{View}</div>
}
