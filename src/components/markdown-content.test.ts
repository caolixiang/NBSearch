import { describe, expect, it } from "bun:test"
import { normalizeAssistantMarkdown, parseThinkSections } from "./markdown-content"

describe("parseThinkSections", () => {
  it("splits think block and normal markdown content", () => {
    const input =
      "<think> [WebSearch] Grok xAI logo official </think> 好的！你要的是适合用作**对话头像**（profile picture / avatar）的Grok相关好看logo或图标对吧？"

    const sections = parseThinkSections(input)
    expect(sections.length).toBe(2)
    expect(sections[0]?.type).toBe("think")
    expect(sections[0]?.value.includes("WebSearch")).toBe(true)
    expect(sections[1]?.type).toBe("text")
    expect(sections[1]?.value.includes("**对话头像**")).toBe(true)
  })

  it("treats unclosed think as thinking mode", () => {
    const sections = parseThinkSections("<think> [WebSearch] A")
    expect(sections.length).toBe(1)
    const first = sections[0]
    expect(first?.type).toBe("think")
    if (!first || first.type !== "think") {
      throw new Error("expected think section")
    }
    expect(first.thinking).toBe(true)
  })
})

describe("normalizeAssistantMarkdown", () => {
  it("drops dangling closing think tag", () => {
    const normalized = normalizeAssistantMarkdown("</think> **bold**")
    expect(normalized).toBe("**bold**")
  })
})
