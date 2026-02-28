import { describe, expect, it } from "bun:test"
import { expandGrokRenderTags, normalizeAssistantMarkdown, parseThinkSections } from "./markdown-content"

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

  it("treats unclosed think as completed when streaming is false", () => {
    const sections = parseThinkSections("<think> [WebSearch] A", {
      treatUnclosedThinkAsThinking: false,
    })
    expect(sections.length).toBe(1)
    const first = sections[0]
    expect(first?.type).toBe("think")
    if (!first || first.type !== "think") {
      throw new Error("expected think section")
    }
    expect(first.thinking).toBe(false)
  })

  it("merges consecutive think blocks into one panel", () => {
    const sections = parseThinkSections("<think>[WebSearch] A</think><think>[Agent 1] B</think>done")
    expect(sections.length).toBe(2)
    expect(sections[0]?.type).toBe("think")
    if (!sections[0] || sections[0].type !== "think") {
      throw new Error("expected merged think section")
    }
    expect(sections[0].value.includes("[WebSearch] A")).toBe(true)
    expect(sections[0].value.includes("[Agent 1] B")).toBe(true)
    expect(sections[1]?.type).toBe("text")
  })

  it("keeps AgentThink sections as think content for downstream agent parsing", () => {
    const sections = parseThinkSections("<think>[AgentThink] Agent 1: foo\nAgent 2: bar</think>")
    expect(sections.length).toBe(1)
    expect(sections[0]?.type).toBe("think")
    if (!sections[0] || sections[0].type !== "think") {
      throw new Error("expected think section")
    }
    expect(sections[0].value.includes("AgentThink")).toBe(true)
    expect(sections[0].value.includes("Agent 1")).toBe(true)
  })
})

describe("normalizeAssistantMarkdown", () => {
  it("drops dangling closing think tag", () => {
    const normalized = normalizeAssistantMarkdown("</think> **bold**")
    expect(normalized).toBe("**bold**")
  })

  it("drops unresolved grok:render tags", () => {
    const normalized = normalizeAssistantMarkdown(
      '<grok:render card_id="abc" card_type="image_card"></grok:render>\n\n正文'
    )
    expect(normalized).toBe("正文")
  })

  it("drops unresolved self-closing grok:render tags", () => {
    const normalized = normalizeAssistantMarkdown('<grok:render card_id="abc" card_type="image_card" />\n\n正文')
    expect(normalized).toBe("正文")
  })
})

describe("expandGrokRenderTags", () => {
  it("replaces grok:render tags with markdown image links", () => {
    const expanded = expandGrokRenderTags(
      '<grok:render card_id="abc" card_type="image_card" type="render_searched_image"></grok:render>',
      {
        abc: {
          id: "abc",
          cardType: "image_card",
          type: "render_searched_image",
          image: {
            original: "https://img.test/a.jpg",
            title: "sample",
            link: "https://source.test",
          },
        },
      }
    )

    expect(expanded).toContain("![sample](<https://img.test/a.jpg>)")
    expect(expanded).toContain("](<https://source.test>)")
  })

  it("replaces self-closing grok:render tags with markdown image links", () => {
    const expanded = expandGrokRenderTags(
      '<grok:render card_id="abc" card_type="image_card" type="render_searched_image" />',
      {
        abc: {
          id: "abc",
          cardType: "image_card",
          type: "render_searched_image",
          image: {
            original: "https://img.test/a.jpg",
            title: "sample",
          },
        },
      }
    )

    expect(expanded).toContain("![sample](<https://img.test/a.jpg>)")
  })
})
