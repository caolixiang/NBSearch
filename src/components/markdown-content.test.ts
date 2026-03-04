import { describe, expect, it } from "bun:test"
import { expandGrokRenderTags, normalizeAssistantMarkdown, parseThinkSections } from "./markdown-content/index"

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

  it("keeps linked markdown image line intact instead of re-extracting inline url", () => {
    const normalized = normalizeAssistantMarkdown("[![alt](https://img.test/photo.jpg)](https://source.test/article)")
    expect(normalized).toBe("![alt](https://img.test/photo.jpg)")
    expect(normalized).not.toContain("Generated Image")
  })

  it("keeps linked markdown image with escaped bracket alt intact", () => {
    const normalized = normalizeAssistantMarkdown(
      "[![Well known \\[紅楓葉- 愛麗絲亞 京都\\]](https://img.test/photo.jpg#fallback=https%3A%2F%2Fimg.test%2Fthumb.jpg)](https://source.test/article)"
    )
    expect(normalized).toBe(
      "![Well known \\[紅楓葉- 愛麗絲亞 京都\\]](https://img.test/photo.jpg#fallback=https%3A%2F%2Fimg.test%2Fthumb.jpg)"
    )
    expect(normalized).not.toContain("Generated Image")
  })

  it("splits inline linked image from paragraph text without creating generated-image duplicates", () => {
    const normalized = normalizeAssistantMarkdown(
      "这是一段说明文字。[![alt](https://img.test/photo.jpg)](https://source.test/article)"
    )

    expect(normalized).toContain("这是一段说明文字。")
    expect(normalized).toContain("![alt](https://img.test/photo.jpg)")
    expect(normalized).not.toContain("Generated Image")
  })

  it("moves sentence-tail dual linked images into one gallery image line", () => {
    const normalized = normalizeAssistantMarkdown(
      [
        "在发布会上哽咽落泪：“这枚金牌献给外婆，我会像她一样勇敢。”[![图一](https://img.test/a.jpg#fallback=https%3A%2F%2Fimg.test%2Fa-thumb.jpg)](https://source.test/a)[![图二](https://img.test/b.jpg#fallback=https%3A%2F%2Fimg.test%2Fb-thumb.jpg)](https://source.test/b)",
        "",
        "下一段",
      ].join("\n")
    )

    expect(normalized).toContain("在发布会上哽咽落泪：“这枚金牌献给外婆，我会像她一样勇敢。”")
    expect(normalized).toContain(
      "![图一](https://img.test/a.jpg#fallback=https%3A%2F%2Fimg.test%2Fa-thumb.jpg) ![图二](https://img.test/b.jpg#fallback=https%3A%2F%2Fimg.test%2Fb-thumb.jpg)"
    )
    expect(normalized).not.toContain("Generated Image")
    expect(normalized).toMatch(/图一[^\n]*图二/)
    expect(normalized).toContain("勇敢。”\n\n![图一]")
  })

  it("drops generated image caption noise between consecutive images", () => {
    const normalized = normalizeAssistantMarkdown(
      [
        "https://img.test/a.jpg",
        "Generated Image有颜有才身家过亿，谷爱凌这么优秀还用攀附豪门？-36氪",
        "https://img.test/b.jpg",
      ].join("\n")
    )

    expect(normalized).toContain("![Generated Image](<https://img.test/a.jpg>) ![Generated Image](<https://img.test/b.jpg>)")
    expect(normalized).not.toContain("Generated Image有颜有才身家过亿")
  })

  it("keeps bold numeric headings intact", () => {
    const normalized = normalizeAssistantMarkdown("**1. 艰辛童年：从流浪儿到革命后代**")
    expect(normalized).toBe("**1. 艰辛童年：从流浪儿到革命后代**")
  })

  it("normalizes broken year range lines to avoid markdown list bullets", () => {
    const normalized = normalizeAssistantMarkdown("字节跳动内部晋升路径（2017\n- 2021）")
    expect(normalized).toBe("字节跳动内部晋升路径（2017 - 2021）")
    expect(normalized).not.toContain("\n- 2021")
  })

  it("keeps heading year ranges intact without forcing list split", () => {
    const normalized = normalizeAssistantMarkdown("### 字节跳动内部晋升路径（2017-2021）")
    expect(normalized).toBe("### 字节跳动内部晋升路径（2017-2021）")
    expect(normalized).not.toContain("\n- 2021")
  })

  it("strips trailing key citations list block from markdown body", () => {
    const normalized = normalizeAssistantMarkdown(
      [
        "结论段落。",
        "",
        "**Key Citations**",
        "- Baidu Baike: 风清扬条目（https://baike.baidu.com/item/%E9%A3%8E%E6%B8%85%E6%89%AC/7056998）",
        "- Wikipedia (Chinese): 岳不群条目（https://zh.wikipedia.org/wiki/%E5%B2%B3%E4%B8%8D%E7%BE%A3）",
      ].join("\n")
    )

    expect(normalized).toBe("结论段落。")
    expect(normalized).not.toContain("Key Citations")
    expect(normalized).not.toContain("baike.baidu.com")
  })

  it("keeps non-citation section when key citations appears in prose", () => {
    const normalized = normalizeAssistantMarkdown("这段话提到了 key citations 这个词，但不是标题。")
    expect(normalized).toBe("这段话提到了 key citations 这个词，但不是标题。")
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
    expect(expanded).toMatch(/\]\(https:\/\/source\.test\/?\)/)
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

  it("ignores citation cards when expanding grok render tags", () => {
    const expanded = expandGrokRenderTags(
      "正文<grok:render card_id=\"c1\" card_type=\"citation_card\"></grok:render>结束",
      {
        c1: {
          id: "c1",
          cardType: "citation_card",
          url: "https://www.britannica.com/biography/Mahmoud-Ahmadinejad",
        },
      }
    )

    expect(expanded).toContain("正文")
    expect(expanded).toContain("结束")
    expect(expanded).not.toContain("![")
    expect(expanded).not.toContain("britannica.com/biography/Mahmoud-Ahmadinejad")
  })

  it("falls back to thumbnail when original is blocked placeholder text", () => {
    const expanded = expandGrokRenderTags(
      '<grok:render card_id="abc" card_type="image_card" type="render_searched_image" />',
      {
        abc: {
          id: "abc",
          cardType: "image_card",
          type: "render_searched_image",
          image: {
            original: "Image blocked: content policy",
            thumbnail: "https://img.test/thumb.jpg",
            title: "sample-thumb",
            link: "https://source.test/article",
          },
        },
      }
    )

    expect(expanded).toContain("![sample-thumb](https://img.test/thumb.jpg)")
    expect(expanded).toContain("](https://source.test/article)")
    expect(expanded).not.toContain("Image%20blocked")
  })

  it("falls back to thumbnail when original is bracketed blocked placeholder", () => {
    const expanded = expandGrokRenderTags(
      '<grok:render card_id="abc" card_type="image_card" type="render_searched_image" />',
      {
        abc: {
          id: "abc",
          cardType: "image_card",
          type: "render_searched_image",
          image: {
            original: "[Image blocked: 景区图]",
            thumbnail: "https://img.test/thumb-bracket.jpg",
            title: "thumb-bracket",
            link: "https://source.test/article-2",
          },
        },
      }
    )

    expect(expanded).toContain("![thumb-bracket](https://img.test/thumb-bracket.jpg)")
    expect(expanded).toContain("](https://source.test/article-2)")
    expect(expanded).not.toContain("Image%20blocked")
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

  it("injects thumbnail fallback when markdown already contains original image url", () => {
    const expanded = expandGrokRenderTags("![Generated Image](<https://img.test/original.jpg>)", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/original.jpg",
          thumbnail: "https://img.test/thumb-for-original.jpg",
          title: "fallback",
        },
      },
    })

    expect(expanded).toContain(
      "![Generated Image](<https://img.test/original.jpg#fallback=https%3A%2F%2Fimg.test%2Fthumb-for-original.jpg>)"
    )
  })

  it("injects fallback when markdown uses http but card original is https", () => {
    const expanded = expandGrokRenderTags("![Generated Image](<http://img.test/mixed.jpg>)", {
      c1: {
        id: "c1",
        cardType: "image_card",
        type: "render_searched_image",
        image: {
          original: "https://img.test/mixed.jpg",
          thumbnail: "https://img.test/mixed-thumb.jpg",
          title: "mixed",
        },
      },
    })

    expect(expanded).toContain(
      "![Generated Image](<http://img.test/mixed.jpg#fallback=https%3A%2F%2Fimg.test%2Fmixed-thumb.jpg>)"
    )
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
