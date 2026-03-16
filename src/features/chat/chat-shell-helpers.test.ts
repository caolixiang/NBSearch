import { describe, expect, it } from "bun:test"
import {
  buildSidebarConversationItems,
  buildVisibleMessages,
  buildVoiceConversationTitle,
  clearStaleSessionAnchors,
  getLastPendingUserMessage,
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
