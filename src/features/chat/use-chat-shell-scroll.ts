import { useCallback, useEffect, useRef, useState } from "react"

export function useChatShellScroll(activeConversationId: string | null, revealDelayMs: number) {
  const [chatInputCollapsedByScroll, setChatInputCollapsedByScroll] = useState(false)
  const [chatInputHeight, setChatInputHeight] = useState(0)

  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)
  const chatInputRevealTimerRef = useRef<number | null>(null)
  const bottomLockRef = useRef(false)

  const clearChatInputRevealTimer = useCallback(() => {
    if (chatInputRevealTimerRef.current) {
      window.clearTimeout(chatInputRevealTimerRef.current)
      chatInputRevealTimerRef.current = null
    }
  }, [])

  const scheduleChatInputReveal = useCallback(() => {
    clearChatInputRevealTimer()
    chatInputRevealTimerRef.current = window.setTimeout(() => {
      setChatInputCollapsedByScroll(false)
      chatInputRevealTimerRef.current = null
    }, revealDelayMs)
  }, [clearChatInputRevealTimer, revealDelayMs])

  const setProgrammaticScrollTop = useCallback((node: HTMLDivElement, nextTop: number) => {
    programmaticScrollRef.current = true
    node.scrollTop = nextTop
    lastScrollTopRef.current = node.scrollTop
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
      lastScrollTopRef.current = node.scrollTop
    })
  }, [])

  const handleMessagesScroll = useCallback(() => {
    const node = messagesScrollRef.current
    if (!node) {
      return
    }
    const currentTop = node.scrollTop
    const previousTop = lastScrollTopRef.current

    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = currentTop
      return
    }

    const hasVerticalOverflow = node.scrollHeight > node.clientHeight + 8
    const delta = currentTop - previousTop
    const hasScrolled = Math.abs(delta) >= 1
    const isScrollingUp = delta < -1
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    const effectiveInputHeight = chatInputHeight > 0 ? chatInputHeight : 140
    const bottomLockEnterPx = Math.max(64, Math.min(128, Math.round(effectiveInputHeight * 0.45)))
    const bottomLockExitPx = Math.max(
      bottomLockEnterPx + 56,
      Math.min(220, Math.round(effectiveInputHeight * 0.95))
    )
    const isInBottomLockZone = distanceToBottom <= bottomLockEnterPx
    if (!hasVerticalOverflow) {
      bottomLockRef.current = false
    } else if (bottomLockRef.current) {
      if (distanceToBottom > bottomLockExitPx) {
        bottomLockRef.current = false
      }
    } else if (isInBottomLockZone) {
      bottomLockRef.current = true
    }

    if (!hasVerticalOverflow || bottomLockRef.current || !isScrollingUp) {
      clearChatInputRevealTimer()
      setChatInputCollapsedByScroll(false)
    } else if (hasScrolled && isScrollingUp) {
      setChatInputCollapsedByScroll(true)
      scheduleChatInputReveal()
    }

    if (isScrollingUp) {
      shouldAutoScrollRef.current = false
      lastScrollTopRef.current = currentTop
      return
    }
    shouldAutoScrollRef.current = distanceToBottom < bottomLockEnterPx
    lastScrollTopRef.current = currentTop
  }, [chatInputHeight, clearChatInputRevealTimer, scheduleChatInputReveal])

  useEffect(() => {
    clearChatInputRevealTimer()
    bottomLockRef.current = false
    setChatInputCollapsedByScroll(false)
  }, [activeConversationId, clearChatInputRevealTimer])

  return {
    chatInputCollapsedByScroll,
    chatInputHeight,
    setChatInputHeight,
    messagesScrollRef,
    shouldAutoScrollRef,
    clearChatInputRevealTimer,
    setProgrammaticScrollTop,
    handleMessagesScroll,
  }
}
