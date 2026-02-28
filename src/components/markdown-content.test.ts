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

  it("drops tool json lines from assistant markdown body", () => {
    const normalized = normalizeAssistantMarkdown(
      [
        '{"query":"张国荣 年轻时 照片","num_results":"15"}',
        '{"url":"https://www.sohu.com/a/379934506_99964114","instructions":"Extract photos"}',
        "以上是张国荣年轻时照片。",
      ].join("\n")
    )
    expect(normalized).toBe("以上是张国荣年轻时照片。")
  })

  it("drops internal relay json lines from assistant markdown body", () => {
    const normalized = normalizeAssistantMarkdown(
      [
        '{"message":"用户要张国荣生平附带图片","to":"Grok"}',
        '{"message":"我已经搜集了生平资料","to":"Agent 2"}',
        "张国荣是香港传奇歌手、演员。",
      ].join("\n")
    )
    expect(normalized).toBe("张国荣是香港传奇歌手、演员。")
  })

  it("converts image_url json lines into markdown image lines", () => {
    const normalized = normalizeAssistantMarkdown('{"image_url":"http://pic2.zhimg.com/50/v2-d554676a8f6871cdb65aea1eff61c140_hd.jpg"}')
    expect(normalized).toContain("![Generated Image](<http://pic2.zhimg.com/50/v2-d554676a8f6871cdb65aea1eff61c140_hd.jpg>)")
  })

  it("drops url-only json lines to avoid rendering non-image pages", () => {
    const normalized = normalizeAssistantMarkdown('{"url":"https://img.test/x.webp"}')
    expect(normalized).toBe("")
  })

  it("converts image tag into markdown image line", () => {
    const normalized = normalizeAssistantMarkdown("<image>https://img.test/a.jpg</image>\n正文")
    expect(normalized).toContain("![Generated Image](<https://img.test/a.jpg>)")
    expect(normalized).toContain("正文")
  })

  it("drops non-image image-tag url without extension", () => {
    const normalized = normalizeAssistantMarkdown("<image>https://img.test/render?id=abc123</image>\n正文")
    expect(normalized).toBe("正文")
  })

  it("converts plain image url line into markdown image line", () => {
    const normalized = normalizeAssistantMarkdown("https://img.test/b.png\n正文")
    expect(normalized).toContain("![Generated Image](<https://img.test/b.png>)")
    expect(normalized).toContain("正文")
  })

  it("extracts inline image urls embedded in text lines", () => {
    const normalized = normalizeAssistantMarkdown(
      "经典肖像：https://upload.wikimedia.org/wikipedia/commons/9/95/Leslie_Cheung.jpg"
    )
    expect(normalized).toContain("经典肖像：")
    expect(normalized).toContain("![Generated Image](<https://upload.wikimedia.org/wikipedia/commons/9/95/Leslie_Cheung.jpg>)")
  })

  it("converts json-like single quote image lines into markdown image line", () => {
    const normalized = normalizeAssistantMarkdown("{'image_url':'https://img.test/c.jpg'}")
    expect(normalized).toBe("![Generated Image](<https://img.test/c.jpg>)")
  })

  it("converts image_url json lines even when url has no file extension", () => {
    const normalized = normalizeAssistantMarkdown('{"image_url":"https://img.test/render?id=xyz"}')
    expect(normalized).toBe("![Generated Image](<https://img.test/render?id=xyz>)")
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

    expect(expanded).toContain("![sample](https://img.test/a.jpg)")
    expect(expanded).toContain("](https://source.test)")
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

    expect(expanded).toContain("![sample](https://img.test/a.jpg)")
  })

  it("appends image cards when content has no grok render placeholders", () => {
    const expanded = expandGrokRenderTags("正文内容", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/fallback-a.jpg",
          title: "fallback",
        },
      },
    })

    expect(expanded).toContain("正文内容")
    expect(expanded).toContain("![fallback](https://img.test/fallback-a.jpg)")
  })

  it("does not append fallback cards when markdown already contains images", () => {
    const expanded = expandGrokRenderTags("![inline](<https://img.test/inline.jpg>)", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/fallback-b.jpg",
          title: "fallback",
        },
      },
    })

    expect(expanded).toContain("![inline](<https://img.test/inline.jpg>)")
    expect(expanded).not.toContain("fallback-b.jpg")
  })

  it("renders fallback cards even when content is empty", () => {
    const expanded = expandGrokRenderTags("   ", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/fallback-c.jpg",
          title: "fallback-c",
        },
      },
    })

    expect(expanded).toContain("![fallback-c](https://img.test/fallback-c.jpg)")
  })

  it("does not show fallback cards before think section is closed", () => {
    const expanded = expandGrokRenderTags("<think>searching images", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/fallback-d.jpg",
          title: "fallback-d",
        },
      },
    })

    expect(expanded).toBe("<think>searching images")
  })

  it("shows fallback cards after think section is closed", () => {
    const expanded = expandGrokRenderTags("<think>done</think>\n正文", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/fallback-e.jpg",
          title: "fallback-e",
        },
      },
    })

    expect(expanded).toContain("</think>")
    expect(expanded).toContain("![fallback-e](https://img.test/fallback-e.jpg)")
  })
})
