import type {
  ChatAnchors,
  ChatAttachment,
  ChatMessage as DomainChatMessage,
  ChatReasoningEventDetail,
  RemoteChatAttachmentInput,
} from "@/domain/chat/types"
import { FEED_SOURCES, getFeedSourceConfig } from "@/domain/feed/source-config"
import type { FeedItemRecord, FeedSource } from "@/domain/feed/types"
import type { ConversationRecord } from "@/domain/storage/repository"
import type { RenderChatMessage } from "@/components/chat-message"
import type { ConversationStreamingState } from "./conversation-streaming-state"
import { buildConversationPdfFileName } from "./export-message-pdf"
import { hasAnyThinkTag, hasOpenThinkTag } from "./chat-stream-runtime"

const DEFAULT_VOICE_CONVERSATION_TITLE_TIMEZONE = "Asia/Shanghai"
export const FEED_SIDEBAR_ID = "feed_x_twitter"

export function resolvePrimaryFeedSource(activeSource: FeedSource | null | undefined): FeedSource {
  return activeSource && FEED_SOURCES.includes(activeSource) ? activeSource : "polymarket"
}

export function buildUnifiedFeedSidebarItem(_input: {
  bySource: Record<FeedSource, { enabled: boolean; isSyncing: boolean }>
}): {
  id: string
  title: string
  description?: string
} {
  return {
    id: FEED_SIDEBAR_ID,
    title: "X / Twitter",
  }
}

export function newConversationId(): string {
  return `conv_${crypto.randomUUID()}`
}

function getDateTimePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value || ""
}

export function buildVoiceConversationTitle(now: Date, timezone?: string): string {
  const normalizedTimezone = typeof timezone === "string" && timezone.trim() ? timezone.trim() : DEFAULT_VOICE_CONVERSATION_TITLE_TIMEZONE
  const formatParts = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = formatParts(normalizedTimezone)
  } catch {
    parts = formatParts(DEFAULT_VOICE_CONVERSATION_TITLE_TIMEZONE)
  }
  const year = getDateTimePart(parts, "year")
  const month = getDateTimePart(parts, "month")
  const day = getDateTimePart(parts, "day")
  const hour = getDateTimePart(parts, "hour")
  const minute = getDateTimePart(parts, "minute")
  return `语音通话${year}${month}${day}${hour}${minute}`
}

export function resolveVoiceResumeConversationId(
  localConversationId: string,
  anchors?: Partial<ChatAnchors>
): string | undefined {
  const sessionId = (anchors?.sessionId || "").trim()
  const candidate = (anchors?.conversationId || "").trim()
  if (!sessionId || !candidate || candidate === localConversationId) {
    return undefined
  }
  return candidate
}

export function clearStaleSessionAnchors(anchors?: Partial<ChatAnchors>): Partial<ChatAnchors> {
  return {
    conversationId: anchors?.conversationId || "",
    sessionId: "",
    lastResponseId: "",
  }
}

export function toRenderMessage(message: DomainChatMessage): RenderChatMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null
  }
  if (!message.content.trim()) {
    return null
  }
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    createdAt: message.createdAt,
    research: message.research,
    responseId: message.responseId,
    previousResponseId: message.previousResponseId,
  }
}

export function buildUserMessageContent(text: string, attachments?: File[]): string {
  const content = text.trim()
  const files = Array.isArray(attachments) ? attachments.filter((file) => Boolean(file)) : []
  if (files.length === 0) {
    return content
  }
  const attachmentLines = files.map((file) => `[附件] ${file.name}`)
  if (!content) {
    return attachmentLines.join("\n")
  }
  return `${content}\n\n${attachmentLines.join("\n")}`
}

function normalizeFeedOriginalText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function stripTrailingEllipsis(value: string): string {
  return value.replace(/[.。…\s]+$/g, "").trim()
}

function shouldTreatFeedOriginalAsDuplicate(left: string, right: string): boolean {
  const normalizedLeft = normalizeFeedOriginalText(left)
  const normalizedRight = normalizeFeedOriginalText(right)
  if (!normalizedLeft || !normalizedRight) {
    return false
  }
  if (normalizedLeft === normalizedRight) {
    return true
  }

  const compactLeft = stripTrailingEllipsis(normalizedLeft)
  const compactRight = stripTrailingEllipsis(normalizedRight)
  if (!compactLeft || !compactRight) {
    return false
  }
  return compactLeft.startsWith(compactRight) || compactRight.startsWith(compactLeft)
}

function pickPreferredFeedOriginalText(left: string, right: string): string {
  const normalizedLeft = left.trim()
  const normalizedRight = right.trim()
  return normalizedLeft.length >= normalizedRight.length ? normalizedLeft : normalizedRight
}

export function buildFeedResearchPrompt(item: FeedItemRecord): string {
  const title = item.title.trim()
  const content = item.contentMarkdown.trim()
  const canonicalUrl = item.canonicalUrl.trim()
  const mediaUrls = item.mediaUrls.map((url) => url.trim()).filter((url) => url.length > 0)
  const sections: string[] = []
  const originalSegments: string[] = []

  if (title && content) {
    if (shouldTreatFeedOriginalAsDuplicate(title, content)) {
      originalSegments.push(pickPreferredFeedOriginalText(title, content))
    } else {
      originalSegments.push(title, content)
    }
  } else if (content) {
    originalSegments.push(content)
  } else if (title) {
    originalSegments.push(title)
  }
  if (originalSegments.length > 0) {
    sections.push(`原文：\n${originalSegments.join("\n\n")}`)
  }
  if (canonicalUrl) {
    sections.push(`原帖链接：\n${canonicalUrl}`)
  }
  if (mediaUrls.length > 0) {
    sections.push(`图片链接：\n${mediaUrls.join("\n")}`)
  }

  sections.push("继续深入调研")
  return sections.join("\n\n").trim()
}

export function buildFeedResearchImageAttachments(item: FeedItemRecord): RemoteChatAttachmentInput[] {
  const sourceLabel = getFeedSourceConfig(item.source).label
  return item.mediaUrls
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((url, index) => ({
      kind: "image_url" as const,
      url,
      name: `${sourceLabel} image ${index + 1}`,
    }))
}

export function buildFeedResearchMessageAttachments(item: FeedItemRecord): ChatAttachment[] {
  const sourceLabel = getFeedSourceConfig(item.source).label
  return item.mediaUrls
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((url, index) => ({
      name: `${sourceLabel} image ${index + 1}`,
      kind: "image" as const,
      previewImageUrl: url,
    }))
}

export function extractRetryableUserText(messageContent: string): string {
  const lines = messageContent.split(/\r?\n/)
  const kept: string[] = []
  for (const line of lines) {
    if (/^\s*\[附件\]\s+/u.test(line)) {
      continue
    }
    kept.push(line)
  }
  return kept.join("\n").trim()
}

export function resolveSendAnchors(
  conversationId: string,
  currentConversation: ConversationRecord | undefined,
  currentMessages: DomainChatMessage[]
): Partial<ChatAnchors> {
  const sessionId = (currentConversation?.anchors.sessionId || "").trim()
  let lastResponseId = (currentConversation?.anchors.lastResponseId || "").trim()
  if (!lastResponseId) {
    for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
      const candidate = currentMessages[index]
      if (candidate?.role !== "assistant") {
        continue
      }
      const responseId = (candidate.responseId || "").trim()
      if (responseId) {
        lastResponseId = responseId
        break
      }
    }
  }
  return {
    conversationId,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionId && lastResponseId ? { lastResponseId } : {}),
  }
}

export function getLastPendingUserMessage(messages: DomainChatMessage[]): DomainChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) {
      continue
    }
    if (message.role === "assistant") {
      return null
    }
    if (message.role === "user") {
      if ((message.voiceEventKey || "").trim()) {
        return null
      }
      return message
    }
  }
  return null
}

export function shouldDeferPendingRecovery(input: {
  isConversationStreaming: boolean
  isHydratingCompletedTurn: boolean
}): boolean {
  return input.isConversationStreaming || input.isHydratingCompletedTurn
}

export function shouldShowPendingRecoveryWarmup(input: {
  pendingUserMessage: DomainChatMessage | null
  isConversationStreaming: boolean
  isPendingRecoverySyncing: boolean
  isHydratingCompletedTurn: boolean
}): boolean {
  return (
    Boolean(input.pendingUserMessage) &&
    !input.isConversationStreaming &&
    !input.isHydratingCompletedTurn &&
    input.isPendingRecoverySyncing
  )
}

export function buildReasoningCaches(list: DomainChatMessage[]): {
  reasoningByMessageId: Record<string, ChatReasoningEventDetail[]>
  reasoningDurationByMessageId: Record<string, number>
} {
  const reasoningByMessageId: Record<string, ChatReasoningEventDetail[]> = {}
  const reasoningDurationByMessageId: Record<string, number> = {}

  for (const message of list) {
    if (message.role !== "assistant") {
      continue
    }
    const messageId = message.id.trim()
    const responseId = message.responseId?.trim() || ""

    if (Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0) {
      reasoningByMessageId[messageId] = message.reasoningEvents
      if (responseId) {
        reasoningByMessageId[responseId] = message.reasoningEvents
      }
    }

    if (
      typeof message.reasoningDurationSeconds === "number" &&
      Number.isFinite(message.reasoningDurationSeconds) &&
      message.reasoningDurationSeconds > 0
    ) {
      const normalizedDuration = Math.max(1, Math.round(message.reasoningDurationSeconds))
      reasoningDurationByMessageId[messageId] = normalizedDuration
      if (responseId) {
        reasoningDurationByMessageId[responseId] = normalizedDuration
      }
    }
  }

  return {
    reasoningByMessageId,
    reasoningDurationByMessageId,
  }
}

export function buildSidebarConversationItems(
  conversations: ConversationRecord[],
  hasDraftConversation: boolean,
  draftConversationId: string,
  draftConversationUpdatedAt: number
): Array<{ id: string; title: string; starred: boolean; updatedAt: Date }> {
  const starred = conversations
    .filter((item) => item.starred)
    .map((item) => ({
      id: item.id,
      title: item.title,
      starred: true,
      updatedAt: new Date(item.updatedAt),
    }))
  const unstarred = conversations
    .filter((item) => !item.starred)
    .map((item) => ({
      id: item.id,
      title: item.title,
      starred: false,
      updatedAt: new Date(item.updatedAt),
    }))
  const mapped = [...starred, ...unstarred]
  if (hasDraftConversation) {
    mapped.unshift({
      id: draftConversationId,
      title: "",
      starred: false,
      updatedAt: new Date(draftConversationUpdatedAt || Date.now()),
    })
  }
  return mapped
}

export function buildVisibleMessages(input: {
  activeMessages: DomainChatMessage[]
  persistedReasoningByMessageId: Record<string, ChatReasoningEventDetail[]>
  persistedReasoningDurationByMessageId: Record<string, number>
  activeStreamingState?: ConversationStreamingState
  activeLeadAnchorMessageId?: string | null
}): RenderChatMessage[] {
  const {
    activeMessages,
    persistedReasoningByMessageId,
    persistedReasoningDurationByMessageId,
    activeStreamingState,
    activeLeadAnchorMessageId,
  } = input

  const rendered = activeMessages
    .map((message) => {
      const row = toRenderMessage(message)
      if (!row || row.role !== "assistant") {
        return row
      }
      const embeddedReasoningEvents =
        Array.isArray(message.reasoningEvents) && message.reasoningEvents.length > 0
          ? message.reasoningEvents
          : undefined
      const byMessageId = persistedReasoningByMessageId[message.id]
      const byResponseId = message.responseId ? persistedReasoningByMessageId[message.responseId] : undefined
      const reasoningEvents = embeddedReasoningEvents || byMessageId || byResponseId
      const embeddedReasoningDuration =
        typeof message.reasoningDurationSeconds === "number" && message.reasoningDurationSeconds > 0
          ? Math.max(1, Math.round(message.reasoningDurationSeconds))
          : 0
      const durationByMessageId = persistedReasoningDurationByMessageId[message.id]
      const durationByResponseId = message.responseId
        ? persistedReasoningDurationByMessageId[message.responseId]
        : undefined
      const reasoningDurationSeconds =
        embeddedReasoningDuration || durationByMessageId || durationByResponseId || 0
      if ((!reasoningEvents || reasoningEvents.length === 0) && reasoningDurationSeconds <= 0) {
        return row
      }
      return {
        ...row,
        reasoningEvents: reasoningEvents || [],
        reasoningActive: false,
        reasoningDurationSeconds,
        research: message.research,
      }
    })
    .filter((item): item is RenderChatMessage => item !== null)

  const activeStreamingAssistantText = activeStreamingState?.assistantText || ""
  const activeStreamingReasoningEvents = activeStreamingState?.reasoningEvents || []
  const activeStreamingReasoningActive = activeStreamingState?.reasoningActive || false
  const activeStreamingReasoningDurationSeconds = activeStreamingState?.reasoningDurationSeconds || 0

  const shouldUseThinkMarkupFallback = activeStreamingReasoningEvents.length === 0
  const hasThinkMarkup = shouldUseThinkMarkupFallback && hasAnyThinkTag(activeStreamingAssistantText)
  const effectiveStreamingReasoningActive =
    hasThinkMarkup ? hasOpenThinkTag(activeStreamingAssistantText) : activeStreamingReasoningActive
  const hasRenderableStreamingAssistant =
    activeStreamingAssistantText.trim().length > 0 || effectiveStreamingReasoningActive

  let visible = rendered
  if (activeStreamingState && activeLeadAnchorMessageId) {
    const anchorIndex = rendered.findIndex((message) => message.id === activeLeadAnchorMessageId)
    if (anchorIndex >= 0 && anchorIndex < rendered.length - 1) {
      visible = rendered.slice(0, anchorIndex + 1)
    }
  }

  if (activeStreamingState && hasRenderableStreamingAssistant) {
    const streamingMessage: RenderChatMessage = {
      id: "streaming_assistant",
      role: "assistant",
      content: activeStreamingAssistantText,
      createdAt: activeStreamingState.startedAt,
      reasoningEvents: activeStreamingReasoningEvents,
      reasoningActive: effectiveStreamingReasoningActive,
      reasoningDurationSeconds: activeStreamingReasoningDurationSeconds,
    }
    if (activeLeadAnchorMessageId) {
      const anchorIndex = visible.findIndex((message) => message.id === activeLeadAnchorMessageId)
      if (anchorIndex >= 0) {
        visible = [
          ...visible.slice(0, anchorIndex + 1),
          streamingMessage,
          ...visible.slice(anchorIndex + 1),
        ]
      } else {
        visible = [...visible, streamingMessage]
      }
    } else {
      const insertIndex = visible.findIndex((message) => {
        const createdAt =
          typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
            ? message.createdAt
            : Number.POSITIVE_INFINITY
        return createdAt > activeStreamingState.startedAt
      })
      if (insertIndex >= 0) {
        visible = [
          ...visible.slice(0, insertIndex),
          streamingMessage,
          ...visible.slice(insertIndex),
        ]
      } else {
        visible = [...visible, streamingMessage]
      }
    }
  }

  return visible
}

export function buildAssistantRoundByMessageId(visibleMessages: RenderChatMessage[]): Record<string, number> {
  const map: Record<string, number> = {}
  let round = 0
  for (const message of visibleMessages) {
    if (message.role !== "assistant" || message.id === "streaming_assistant") {
      continue
    }
    round += 1
    map[message.id] = round
  }
  return map
}

export function findLatestAssistantMessageId(visibleMessages: RenderChatMessage[]): string {
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index]
    if (message.role !== "assistant" || message.id === "streaming_assistant") {
      continue
    }
    return message.id
  }
  return ""
}

export function buildPdfExportMetaByMessageId(
  activeConversationTitle: string,
  assistantRoundByMessageId: Record<string, number>
): Record<string, { title: string; round: number; fileName: string }> {
  const map: Record<string, { title: string; round: number; fileName: string }> = {}
  for (const [messageId, round] of Object.entries(assistantRoundByMessageId)) {
    map[messageId] = {
      title: activeConversationTitle,
      round,
      fileName: buildConversationPdfFileName(activeConversationTitle, round),
    }
  }
  return map
}

export function buildStreamingReasoningViewModel(
  activeStreamingState: ConversationStreamingState | undefined,
  isActiveConversationStreaming: boolean
): {
  activeStreamingAssistantText: string
  activeStreamingReasoningEvents: ChatReasoningEventDetail[]
  activeStreamingReasoningActive: boolean
  activeStreamingReasoningDurationSeconds: number
  effectiveStreamingReasoningActive: boolean
  isThinkingStreaming: boolean
  shouldShowThinkingWarmup: boolean
} {
  const activeStreamingAssistantText = activeStreamingState?.assistantText || ""
  const activeStreamingReasoningEvents = activeStreamingState?.reasoningEvents || []
  const activeStreamingReasoningActive = activeStreamingState?.reasoningActive || false
  const activeStreamingReasoningDurationSeconds = activeStreamingState?.reasoningDurationSeconds || 0
  const shouldUseThinkMarkupFallback = activeStreamingReasoningEvents.length === 0
  const hasThinkMarkup = shouldUseThinkMarkupFallback && hasAnyThinkTag(activeStreamingAssistantText)
  const effectiveStreamingReasoningActive =
    hasThinkMarkup ? hasOpenThinkTag(activeStreamingAssistantText) : activeStreamingReasoningActive
  const isThinkingStreaming = isActiveConversationStreaming && effectiveStreamingReasoningActive
  const shouldShowThinkingWarmup =
    isActiveConversationStreaming &&
    activeStreamingAssistantText.trim().length === 0 &&
    !isThinkingStreaming

  return {
    activeStreamingAssistantText,
    activeStreamingReasoningEvents,
    activeStreamingReasoningActive,
    activeStreamingReasoningDurationSeconds,
    effectiveStreamingReasoningActive,
    isThinkingStreaming,
    shouldShowThinkingWarmup,
  }
}

export function computeMessageBottomSpacerPx(chatInputHeight: number, isThinkingStreaming: boolean): number {
  const base = isThinkingStreaming ? 40 : 16
  const effectiveInputHeight = chatInputHeight > 0 ? chatInputHeight : 140
  const comfortBuffer = Math.round(effectiveInputHeight * 0.62 + 14)
  return Math.max(base, Math.min(comfortBuffer, 164))
}
