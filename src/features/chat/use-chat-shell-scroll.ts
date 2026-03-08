import { useCallback, useEffect, useRef, useState } from "react"

interface DeriveChatScrollStateInput {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  previousTop: number
  bottomLock: boolean
  chatInputHeight: number
}

interface DeriveChatScrollStateResult {
  nextBottomLock: boolean
  shouldAutoScroll: boolean
  isScrollingUp: boolean
}

export function deriveChatScrollState({
  scrollHeight,
  clientHeight,
  scrollTop,
  previousTop,
  bottomLock,
  chatInputHeight,
}: DeriveChatScrollStateInput): DeriveChatScrollStateResult {
  const hasVerticalOverflow = scrollHeight > clientHeight + 8
  const delta = scrollTop - previousTop
  const isScrollingUp = delta < -1
  const distanceToBottom = scrollHeight - scrollTop - clientHeight
  const effectiveInputHeight = chatInputHeight > 0 ? chatInputHeight : 140
  const bottomLockEnterPx = Math.max(64, Math.min(128, Math.round(effectiveInputHeight * 0.45)))
  const bottomLockExitPx = Math.max(
    bottomLockEnterPx + 56,
    Math.min(220, Math.round(effectiveInputHeight * 0.95))
  )

  let nextBottomLock = bottomLock
  if (!hasVerticalOverflow) {
    nextBottomLock = false
  } else if (nextBottomLock) {
    if (distanceToBottom > bottomLockExitPx) {
      nextBottomLock = false
    }
  } else if (distanceToBottom <= bottomLockEnterPx) {
    nextBottomLock = true
  }

  const shouldAutoScroll = !isScrollingUp && distanceToBottom < bottomLockEnterPx

  return {
    nextBottomLock,
    shouldAutoScroll,
    isScrollingUp,
  }
}

export function useChatShellScroll(activeConversationId: string | null) {
  const [chatInputHeight, setChatInputHeight] = useState(0)

  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const programmaticScrollRef = useRef(false)
  const bottomLockRef = useRef(false)

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
    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = currentTop
      return
    }

    const nextState = deriveChatScrollState({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      scrollTop: currentTop,
      previousTop: lastScrollTopRef.current,
      bottomLock: bottomLockRef.current,
      chatInputHeight,
    })

    bottomLockRef.current = nextState.nextBottomLock
    shouldAutoScrollRef.current = nextState.shouldAutoScroll
    lastScrollTopRef.current = currentTop
  }, [chatInputHeight])

  useEffect(() => {
    bottomLockRef.current = false
    shouldAutoScrollRef.current = true
    lastScrollTopRef.current = 0
  }, [activeConversationId])

  return {
    chatInputHeight,
    setChatInputHeight,
    messagesScrollRef,
    shouldAutoScrollRef,
    setProgrammaticScrollTop,
    handleMessagesScroll,
  }
}
