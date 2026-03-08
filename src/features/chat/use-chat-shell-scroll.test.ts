import { describe, expect, it } from "bun:test"
import { deriveChatScrollState } from "./use-chat-shell-scroll"

describe("deriveChatScrollState", () => {
  it("enables bottom lock and auto-scroll when the viewport stays near the bottom", () => {
    const result = deriveChatScrollState({
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 350,
      previousTop: 340,
      bottomLock: false,
      chatInputHeight: 140,
    })

    expect(result).toEqual({
      nextBottomLock: true,
      shouldAutoScroll: true,
      isScrollingUp: false,
    })
  })

  it("disables auto-scroll when the user scrolls upward", () => {
    const result = deriveChatScrollState({
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 350,
      previousTop: 400,
      bottomLock: true,
      chatInputHeight: 140,
    })

    expect(result).toEqual({
      nextBottomLock: true,
      shouldAutoScroll: false,
      isScrollingUp: true,
    })
  })

  it("releases bottom lock after leaving the exit threshold", () => {
    const result = deriveChatScrollState({
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 180,
      previousTop: 160,
      bottomLock: true,
      chatInputHeight: 140,
    })

    expect(result).toEqual({
      nextBottomLock: false,
      shouldAutoScroll: false,
      isScrollingUp: false,
    })
  })
})
