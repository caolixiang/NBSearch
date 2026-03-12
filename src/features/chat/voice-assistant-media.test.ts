import { describe, expect, it } from "bun:test"
import {
  backfillVoiceAssistantMessageCards,
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

  it("backfills late-arriving cards into an already persisted assistant message", () => {
    const nextMessage = backfillVoiceAssistantMessageCards(
      {
        id: "voice_asst_late_1",
        role: "assistant",
        content:
          '北京的晴空长城照：\n\n<render_searched_image image_id="0" size="LARGE" />\n\n上海的江景：\n\n<render_searched_image image_id="1" size="LARGE" />',
        responseId: "resp_voice_late_1",
        createdAt: 100,
      },
      [
        {
          id: "card_beijing",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/beijing.jpg" },
        },
        {
          id: "card_shanghai",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/shanghai.jpg" },
        },
      ]
    )

    expect(nextMessage).not.toBeNull()
    expect(nextMessage?.content).toContain("<tool-meta>")
    expect(nextMessage?.content).toContain("\"card_beijing\"")
    expect(nextMessage?.reasoningEvents).toEqual([
      {
        kind: "card_attachment",
        card: {
          id: "card_beijing",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/beijing.jpg" },
        },
      },
      {
        kind: "card_attachment",
        card: {
          id: "card_shanghai",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/shanghai.jpg" },
        },
      },
    ])
  })

  it("merges late-arriving cards with existing assistant tool-meta cards", () => {
    const nextMessage = backfillVoiceAssistantMessageCards(
      {
        id: "voice_asst_late_2",
        role: "assistant",
        content:
          '这里有图。\n<tool-meta>{"webSearch":[],"cards":[{"id":"card_existing","cardType":"image_card","type":"render_searched_image","image":{"original":"https://img.test/existing.jpg"}}]}</tool-meta>',
        reasoningEvents: [
          {
            kind: "card_attachment",
            card: {
              id: "card_existing",
              cardType: "image_card",
              type: "render_searched_image",
              image: { original: "https://img.test/existing.jpg" },
            },
          },
        ],
        responseId: "resp_voice_late_2",
        createdAt: 200,
      },
      [
        {
          id: "card_new",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/new.jpg" },
        },
      ]
    )

    expect(nextMessage).not.toBeNull()
    expect(nextMessage?.content).toContain("\"card_existing\"")
    expect(nextMessage?.content).toContain("\"card_new\"")
    expect(nextMessage?.reasoningEvents).toHaveLength(2)
  })
})
