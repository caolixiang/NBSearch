import { describe, expect, it } from "bun:test"
import { normalizeAssistantMarkdown } from "./markdown-content"

describe("normalizeAssistantMarkdown", () => {
  it("strips think blocks and keeps markdown after closing tag", () => {
    const input =
      "<think> [WebSearch] Grok xAI logo official </think> 好的！你要的是适合用作**对话头像**（profile picture / avatar）的Grok相关好看logo或图标对吧？"

    const normalized = normalizeAssistantMarkdown(input)

    expect(normalized.includes("<think>")).toBe(false)
    expect(normalized.includes("</think>")).toBe(false)
    expect(normalized.startsWith("好的！")).toBe(true)
    expect(normalized.includes("**对话头像**")).toBe(true)
  })

  it("drops dangling closing think tag", () => {
    const normalized = normalizeAssistantMarkdown("</think> **bold**")
    expect(normalized).toBe("**bold**")
  })
})
