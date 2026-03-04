import { describe, expect, it } from "bun:test"
import type { ChatReasoningEventDetail } from "@/domain/chat/types"
import {
  buildCitationItems,
  extractTrailingKeyCitationEntries,
  shouldHidePdfExportForGeneratedContent,
} from "./chat-message"

describe("extractTrailingKeyCitationEntries", () => {
  it("parses trailing key citations in multiple url formats", () => {
    const entries = extractTrailingKeyCitationEntries(
      [
        "结论段落。",
        "",
        "**Key Citations**",
        "- Baidu: 风清扬（https://baike.baidu.com/item/%E9%A3%8E%E6%B8%85%E6%89%AC/7056998）",
        "- [Wikipedia 岳不群](https://zh.wikipedia.org/wiki/%E5%B2%B3%E4%B8%8D%E7%BE%A3)",
        "- Harvard report",
        "  https://example.com/report",
      ].join("\n")
    )

    expect(entries).toHaveLength(3)
    expect(entries[0]?.url).toContain("baike.baidu.com")
    expect(entries[0]?.label).toContain("Baidu")
    expect(entries[1]?.url).toContain("zh.wikipedia.org")
    expect(entries[1]?.label).toContain("Wikipedia")
    expect(entries[2]?.url).toBe("https://example.com/report")
    expect(entries[2]?.label).toContain("Harvard report")
  })

  it("returns empty when heading is missing", () => {
    const entries = extractTrailingKeyCitationEntries("普通正文，不带 Key Citations 标题。\nhttps://example.com")
    expect(entries).toEqual([])
  })

  it("ignores tool-meta blocks inside trailing key citations area", () => {
    const entries = extractTrailingKeyCitationEntries(
      [
        "结论段落。",
        "",
        "**Key Citations**",
        "<tool-meta>{\"webSearch\":[],\"cards\":[{\"id\":\"473ab9\",\"cardType\":\"image_card\",\"type\":\"render_searched_image\",\"image\":{\"thumbnail\":\"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSO4Z6uWwlc9d7mv94sa4ji2JSfWGTycm86PQ&s\",\"original\":\"http://image.sciencenet.cn/home/202504/20/222857dxivmmjbxpuijiwb.jpg\",\"title\":\"科学网\",\"link\":\"https://wap.sciencenet.cn/blog-107667-1482744.html?mobile=1\",\"source\":\"科学网\"}}]}</tool-meta>",
      ].join("\n")
    )

    expect(entries).toEqual([])
  })
})

describe("buildCitationItems", () => {
  it("uses tail citations when inline citations are absent", () => {
    const rows = buildCitationItems(
      undefined,
      undefined,
      [
        "正文。",
        "",
        "Key Citations:",
        "- Official stats (https://stats.example.com/a)",
        "- https://news.example.com/b",
      ].join("\n")
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]?.url).toBe("https://stats.example.com/a")
    expect(rows[1]?.url).toBe("https://news.example.com/b")
  })

  it("merges inline and tail citations while deduplicating by url", () => {
    const events: ChatReasoningEventDetail[] = [
      {
        kind: "tool_result",
        result: {
          webSearchResults: [{ url: "https://b.example.com/ref", title: "Ref B Title" }],
        },
      },
    ]
    const rows = buildCitationItems(
      {
        inlineCitations: [{ cardId: "card_a", citationId: "c1" }],
        citationCards: [{ cardId: "card_a", url: "https://a.example.com/ref" }],
      },
      events,
      [
        "正文。",
        "",
        "**Key Citations**",
        "- A Ref（https://a.example.com/ref）",
        "- B Ref（https://b.example.com/ref）",
      ].join("\n")
    )

    expect(rows).toHaveLength(2)
    expect(rows[0]?.key).toBe("card_a\u0000c1")
    expect(rows[0]?.url).toBe("https://a.example.com/ref")
    expect(rows[1]?.url).toBe("https://b.example.com/ref")
    expect(rows[1]?.label).toBe("B Ref")
  })
})

describe("shouldHidePdfExportForGeneratedContent", () => {
  it("returns true for pure generated-image tool-meta blocks", () => {
    const content = [
      "![Generated Image](<https://example.com/a.jpg>)",
      "<tool-meta>{\"webSearch\":[],\"cards\":[{\"id\":\"card_a\",\"type\":\"generated_image\"},{\"id\":\"card_b\",\"type\":\"generated_image\"}]}</tool-meta>",
    ].join("\n")

    expect(shouldHidePdfExportForGeneratedContent(content)).toBe(true)
  })

  it("returns false when tool-meta includes non-generated cards", () => {
    const content = [
      "正文",
      "<tool-meta>{\"webSearch\":[],\"cards\":[{\"id\":\"card_a\",\"type\":\"generated_image\"},{\"id\":\"card_b\",\"type\":\"citation_card\"}]}</tool-meta>",
    ].join("\n")

    expect(shouldHidePdfExportForGeneratedContent(content)).toBe(false)
  })

  it("returns false when no tool-meta exists", () => {
    expect(shouldHidePdfExportForGeneratedContent("普通回答内容")).toBe(false)
  })
})
