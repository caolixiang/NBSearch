import { describe, expect, it } from "bun:test"
import {
  buildUnifiedFeedSidebarItem,
  buildSidebarConversationItems,
  buildFeedResearchImageAttachments,
  buildFeedResearchMessageAttachments,
  buildFeedResearchPrompt,
  buildVisibleMessages,
  buildVoiceConversationTitle,
  clearStaleSessionAnchors,
  FEED_SIDEBAR_ID,
  getLastPendingUserMessage,
  resolvePrimaryFeedSource,
  resolveVoiceResumeConversationId,
  shouldDeferPendingRecovery,
  shouldShowPendingRecoveryWarmup,
} from "./chat-shell-helpers"

describe("chat-shell voice resume helpers", () => {
  it("skips voice resume when the conversation has no upstream session", () => {
    expect(
      resolveVoiceResumeConversationId("conv_local_1", {
        conversationId: "conv_local_1",
      })
    ).toBeUndefined()
  })

  it("skips voice resume when anchors still point at the local conversation id", () => {
    expect(
      resolveVoiceResumeConversationId("conv_local_1", {
        sessionId: "sess_existing_1",
        conversationId: "conv_local_1",
      })
    ).toBeUndefined()
  })

  it("returns the upstream conversation id for strict voice resume", () => {
    expect(
      resolveVoiceResumeConversationId("conv_local_1", {
        sessionId: "sess_existing_1",
        conversationId: "conv_upstream_1",
      })
    ).toBe("conv_upstream_1")
  })

  it("formats direct voice chat titles with timestamp digits", () => {
    expect(buildVoiceConversationTitle(new Date("2026-03-12T07:28:00.000Z"), "Asia/Shanghai")).toBe(
      "语音通话202603121528"
    )
  })

  it("falls back to Asia/Shanghai when the voice title timezone is invalid", () => {
    expect(buildVoiceConversationTitle(new Date("2026-03-12T07:28:00.000Z"), "Invalid/Zone")).toBe(
      "语音通话202603121528"
    )
  })

  it("clears stale remote anchors but keeps the local conversation id", () => {
    expect(
      clearStaleSessionAnchors({
        conversationId: "conv_local_1",
        sessionId: "sess_stale_1",
        lastResponseId: "resp_stale_1",
      })
    ).toEqual({
      conversationId: "conv_local_1",
      sessionId: "",
      lastResponseId: "",
    })
  })

  it("does not treat voice user finals as pending recovery messages", () => {
    expect(
      getLastPendingUserMessage([
        {
          id: "voice_user_1",
          role: "user",
          content: "帮我看下这张图",
          voiceEventKey: "user:resp:resp_voice_1",
          createdAt: 100,
        },
      ])
    ).toBeNull()
  })

  it("defers pending recovery while a completed turn is still hydrating local messages", () => {
    expect(
      shouldDeferPendingRecovery({
        isConversationStreaming: false,
        isHydratingCompletedTurn: true,
      })
    ).toBe(true)
  })

  it("does not show pending recovery warmup while completed turn hydration is in progress", () => {
    expect(
      shouldShowPendingRecoveryWarmup({
        pendingUserMessage: {
          id: "user_1",
          role: "user",
          content: "给我一张图",
          createdAt: 100,
        },
        isConversationStreaming: false,
        isPendingRecoverySyncing: true,
        isHydratingCompletedTurn: true,
      })
    ).toBe(false)
  })

  it("keeps an active voice assistant stream above newer user voice turns", () => {
    const visible = buildVisibleMessages({
      activeMessages: [
        {
          id: "assistant_old_1",
          role: "assistant",
          content: "前一轮已完成",
          createdAt: 100,
        },
        {
          id: "voice_user_new_1",
          role: "user",
          content: "我再插一句",
          createdAt: 260,
          voiceEventKey: "user:resp:resp_voice_user_new_1",
        },
      ],
      persistedReasoningByMessageId: {},
      persistedReasoningDurationByMessageId: {},
      activeStreamingState: {
        assistantText: "上一条语音回答还在继续",
        reasoningEvents: [],
        reasoningActive: false,
        reasoningDurationSeconds: 0,
        startedAt: 180,
        leadAnchorMessageId: null,
      },
      activeLeadAnchorMessageId: null,
    })

    expect(visible.map((message) => message.id)).toEqual([
      "assistant_old_1",
      "streaming_assistant",
      "voice_user_new_1",
    ])
  })

  it("orders starred conversations ahead of time groups while keeping draft unstarred", () => {
    const items = buildSidebarConversationItems(
      [
        {
          id: "conv_today_1",
          title: "今天未星标",
          starred: false,
          anchors: {},
          createdAt: 1,
          updatedAt: new Date("2026-03-16T08:00:00.000Z").getTime(),
        },
        {
          id: "conv_star_1",
          title: "星标会话",
          starred: true,
          anchors: {},
          createdAt: 2,
          updatedAt: new Date("2026-03-15T08:00:00.000Z").getTime(),
        },
      ],
      true,
      "draft_conversation",
      new Date("2026-03-16T09:00:00.000Z").getTime()
    )

    expect(items.map((item) => [item.id, item.starred])).toEqual([
      ["draft_conversation", false],
      ["conv_star_1", true],
      ["conv_today_1", false],
    ])
  })
})

describe("chat-shell unified feed sidebar", () => {
  it("falls back to the first enabled source when no feed source is active yet", () => {
    expect(resolvePrimaryFeedSource(null, ["polymarket", "kalshi"])).toBe("polymarket")
    expect(resolvePrimaryFeedSource("kalshi", ["polymarket", "kalshi"])).toBe("kalshi")
    expect(resolvePrimaryFeedSource("x:elonmusk", ["polymarket", "kalshi"])).toBe("polymarket")
  })

  it("returns null when there are no enabled feed sources", () => {
    expect(resolvePrimaryFeedSource(null, [])).toBeNull()
    expect(resolvePrimaryFeedSource("polymarket", [])).toBeNull()
  })

  it("builds a single X / Twitter sidebar item", () => {
    expect(buildUnifiedFeedSidebarItem()).toEqual({
      id: FEED_SIDEBAR_ID,
      title: "X / Twitter",
    })
  })
})

describe("polymarket feed to chat helpers", () => {
  const item = {
    id: "feed_1",
    subscriptionId: "sub_1",
    source: "polymarket" as const,
    contentHash: "hash_1",
    title: "Original headline",
    contentMarkdown: "Original body",
    titleZh: "中文标题",
    contentMarkdownZh: "中文正文",
    translationStatus: "translated" as const,
    translationModel: "gpt-5.4-mini",
    translatedAt: 1,
    mediaUrls: ["https://example.com/one.png", " https://example.com/two.jpg "],
    canonicalUrl: "https://x.com/polymarket/status/1",
    publishedAt: 1,
    discoveredAt: 1,
    fetchedAt: 1,
  }

  it("builds deep research prompts from original feed content instead of translated text", () => {
    expect(buildFeedResearchPrompt(item)).toBe(
      [
        "原文：",
        "Original headline",
        "",
        "Original body",
        "",
        "原帖链接：",
        "https://x.com/polymarket/status/1",
        "",
        "图片链接：",
        "https://example.com/one.png",
        "https://example.com/two.jpg",
        "",
        "继续深入调研",
      ].join("\n")
    )
  })

  it("deduplicates identical title and content into a single original block", () => {
    expect(
      buildFeedResearchPrompt({
        ...item,
        contentMarkdown: "Original headline",
      })
    ).toBe(
      [
        "原文：",
        "Original headline",
        "",
        "原帖链接：",
        "https://x.com/polymarket/status/1",
        "",
        "图片链接：",
        "https://example.com/one.png",
        "https://example.com/two.jpg",
        "",
        "继续深入调研",
      ].join("\n")
    )
  })

  it("deduplicates a truncated title when the body is the longer original text", () => {
    expect(
      buildFeedResearchPrompt({
        ...item,
        title: "JUST IN: “At least a dozen” military officers were missing from China’s legislative meetings,...",
        contentMarkdown:
          "JUST IN: “At least a dozen” military officers were missing from China’s legislative meetings, suspected to have been purged by Xi.",
      })
    ).toBe(
      [
        "原文：",
        "JUST IN: “At least a dozen” military officers were missing from China’s legislative meetings, suspected to have been purged by Xi.",
        "",
        "原帖链接：",
        "https://x.com/polymarket/status/1",
        "",
        "图片链接：",
        "https://example.com/one.png",
        "https://example.com/two.jpg",
        "",
        "继续深入调研",
      ].join("\n")
    )
  })

  it("builds remote image attachments for request payload and local preview", () => {
    expect(buildFeedResearchImageAttachments(item)).toEqual([
      {
        kind: "image_url",
        url: "https://example.com/one.png",
        name: "Polymarket image 1",
      },
      {
        kind: "image_url",
        url: "https://example.com/two.jpg",
        name: "Polymarket image 2",
      },
    ])

    expect(buildFeedResearchMessageAttachments(item)).toEqual([
      {
        name: "Polymarket image 1",
        kind: "image",
        previewImageUrl: "https://example.com/one.png",
      },
      {
        name: "Polymarket image 2",
        kind: "image",
        previewImageUrl: "https://example.com/two.jpg",
      },
    ])
  })

  it("uses the source label when building image attachment names", () => {
    expect(
      buildFeedResearchImageAttachments({
        ...item,
        source: "kalshi" as const,
      })[0]
    ).toMatchObject({
      name: "Kalshi image 1",
    })
  })
})
