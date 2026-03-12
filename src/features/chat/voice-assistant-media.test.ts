import { describe, expect, it } from "bun:test"
import {
  buildVoiceAssistantMessageContent,
  buildVoiceAssistantReasoningEvents,
  mergeVoiceAssistantCards,
} from "./voice-assistant-media"

describe("voice-assistant-media", () => {
  it("merges assistant cards by id while preserving first-seen order", () => {
    const merged = mergeVoiceAssistantCards(
      [
        {
          id: "card_a",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/a-old.jpg" },
        },
      ],
      [
        {
          id: "card_a",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/a-new.jpg" },
        },
        {
          id: "card_b",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/b.jpg" },
        },
      ]
    )

    expect(merged).toHaveLength(2)
    expect(merged[0]?.id).toBe("card_a")
    expect(merged[0]?.image?.original).toBe("https://img.test/a-new.jpg")
    expect(merged[1]?.id).toBe("card_b")
  })

  it("builds assistant content with tool-meta cards", () => {
    const content = buildVoiceAssistantMessageContent("这里有两张图。", [
      {
        id: "card_a",
        cardType: "image_card",
        type: "render_searched_image",
        image: { original: "https://img.test/a.jpg" },
      },
    ])

    expect(content).toContain("这里有两张图。")
    expect(content).toContain("<tool-meta>")
    expect(content).toContain("\"card_a\"")
  })

  it("supports cards-only assistant content", () => {
    const content = buildVoiceAssistantMessageContent("", [
      {
        id: "card_only",
        cardType: "image_card",
        type: "render_searched_image",
        image: { original: "https://img.test/only.jpg" },
      },
    ])

    expect(content).toBe(
      '<tool-meta>{"webSearch":[],"cards":[{"id":"card_only","cardType":"image_card","type":"render_searched_image","image":{"original":"https://img.test/only.jpg"}}]}</tool-meta>'
    )
  })

  it("maps cards into card_attachment reasoning events", () => {
    const events = buildVoiceAssistantReasoningEvents([
      {
        id: "card_a",
        cardType: "image_card",
        type: "render_searched_image",
        image: { original: "https://img.test/a.jpg" },
      },
    ])

    expect(events).toEqual([
      {
        kind: "card_attachment",
        card: {
          id: "card_a",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/a.jpg" },
        },
      },
    ])
  })
})
