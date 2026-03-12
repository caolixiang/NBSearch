import { describe, expect, it } from "bun:test"
import type { ConversationRecord } from "@/domain/storage/repository"
import { MemoryAppRepository } from "@/infrastructure/storage/memory/repository"
import { commitVoiceMessage } from "./voice-message-commit"

describe("commitVoiceMessage", () => {
  it("persists the first voice user message without inventing a title", async () => {
    const repository = new MemoryAppRepository()
    const conversation: ConversationRecord = {
      id: "conv_voice_1",
      title: "",
      anchors: {
        conversationId: "conv_voice_1",
      },
      createdAt: 100,
      updatedAt: 100,
    }
    await repository.upsertConversation(conversation)

    const result = await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "user",
      text: "给我讲个笑话",
      sessionId: "sess_voice_1",
      now: 200,
    })

    expect(result.skipped).toBe(false)
    expect(result.message?.role).toBe("user")
    expect(result.conversation.title).toBe("")
    expect(result.conversation.anchors.sessionId).toBe("sess_voice_1")

    const messages = await repository.listMessages(conversation.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe("给我讲个笑话")
  })

  it("updates lastResponseId for assistant replies and dedupes by responseId", async () => {
    const repository = new MemoryAppRepository()
    const conversation: ConversationRecord = {
      id: "conv_voice_2",
      title: "语音测试",
      anchors: {
        conversationId: "conv_voice_2",
        sessionId: "sess_voice_2",
        lastResponseId: "resp_prev_1",
      },
      createdAt: 100,
      updatedAt: 100,
    }
    await repository.upsertConversation(conversation)

    const first = await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "assistant",
      text: "当然可以。",
      sessionId: "sess_voice_2",
      responseId: "resp_voice_2",
      previousResponseId: "resp_prev_1",
      now: 210,
    })
    const second = await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "assistant",
      text: "当然可以。",
      sessionId: "sess_voice_2",
      responseId: "resp_voice_2",
      previousResponseId: "resp_prev_1",
      now: 220,
    })

    expect(first.skipped).toBe(false)
    expect(second.skipped).toBe(true)

    const messages = await repository.listMessages(conversation.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.responseId).toBe("resp_voice_2")
    expect(messages[0]?.previousResponseId).toBe("resp_prev_1")

    const updatedConversation = (await repository.listConversations()).find((item) => item.id === conversation.id)
    expect(updatedConversation?.anchors.lastResponseId).toBe("resp_voice_2")
    expect(updatedConversation?.updatedAt).toBe(220)
  })

  it("replaces refined user transcript when the same voice turn emits another final transcript", async () => {
    const repository = new MemoryAppRepository()
    const conversation: ConversationRecord = {
      id: "conv_voice_3",
      title: "",
      anchors: {
        conversationId: "conv_voice_3",
        sessionId: "sess_voice_3",
      },
      createdAt: 100,
      updatedAt: 100,
    }
    await repository.upsertConversation(conversation)

    const first = await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "user",
      text: "给我看两个",
      voiceEventKey: "user:resp:resp_voice_turn_1",
      sessionId: "sess_voice_3",
      now: 210,
    })
    const second = await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "user",
      text: "给我看两个埃隆马斯克的照片。",
      voiceEventKey: "user:resp:resp_voice_turn_1",
      sessionId: "sess_voice_3",
      now: 220,
    })

    expect(first.skipped).toBe(false)
    expect(second.skipped).toBe(false)

    const messages = await repository.listMessages(conversation.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe("给我看两个埃隆马斯克的照片。")
    expect(messages[0]?.voiceEventKey).toBe("user:resp:resp_voice_turn_1")

    const updatedConversation = (await repository.listConversations()).find((item) => item.id === conversation.id)
    expect(updatedConversation?.title).toBe("")
    expect(updatedConversation?.updatedAt).toBe(220)
  })

  it("accepts an explicit upstream title when voice title becomes available", async () => {
    const repository = new MemoryAppRepository()
    const conversation: ConversationRecord = {
      id: "conv_voice_5",
      title: "",
      anchors: {
        conversationId: "conv_voice_5",
        sessionId: "sess_voice_5",
      },
      createdAt: 100,
      updatedAt: 100,
    }
    await repository.upsertConversation(conversation)

    const result = await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "assistant",
      text: "当然可以。",
      sessionId: "sess_voice_5",
      responseId: "resp_voice_5",
      previousResponseId: "resp_prev_5",
      upstreamTitle: "语音标题",
      now: 240,
    })

    expect(result.conversation.title).toBe("语音标题")
  })

  it("persists assistant reasoning card attachments for voice image replies", async () => {
    const repository = new MemoryAppRepository()
    const conversation: ConversationRecord = {
      id: "conv_voice_4",
      title: "语音图片",
      anchors: {
        conversationId: "conv_voice_4",
        sessionId: "sess_voice_4",
        lastResponseId: "resp_prev_4",
      },
      createdAt: 100,
      updatedAt: 100,
    }
    await repository.upsertConversation(conversation)

    await commitVoiceMessage({
      repository,
      conversationId: conversation.id,
      fallbackConversation: conversation,
      role: "assistant",
      text:
        '这里有两张图。\\n<tool-meta>{"webSearch":[],"cards":[{"id":"card_1","cardType":"image_card","type":"render_searched_image","image":{"original":"https://img.test/a.jpg"}}]}</tool-meta>',
      reasoningEvents: [
        {
          kind: "card_attachment",
          card: {
            id: "card_1",
            cardType: "image_card",
            type: "render_searched_image",
            image: { original: "https://img.test/a.jpg" },
          },
        },
      ],
      sessionId: "sess_voice_4",
      responseId: "resp_voice_4",
      previousResponseId: "resp_prev_4",
      now: 230,
    })

    const messages = await repository.listMessages(conversation.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toContain("<tool-meta>")
    expect(messages[0]?.reasoningEvents).toEqual([
      {
        kind: "card_attachment",
        card: {
          id: "card_1",
          cardType: "image_card",
          type: "render_searched_image",
          image: { original: "https://img.test/a.jpg" },
        },
      },
    ])
  })
})
