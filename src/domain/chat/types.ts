export type ChatMessageRole = "system" | "user" | "assistant" | "tool"

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningDurationSeconds?: number
  research?: ChatDeepSearchResearch
  responseId?: string
  previousResponseId?: string
  status?: "streaming" | "completed" | "failed"
  createdAt: number
}

export interface ChatAnchors {
  sessionId: string
  conversationId: string
  lastResponseId: string
}

export interface SendChatTurnInput {
  model: string
  text: string
  attachments?: File[]
  anchors: Partial<ChatAnchors>
  deepSearch?: boolean
  regenerateTargetResponseId?: string
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface ChatReasoningLayout {
  reasoningUiLayout?: string
  willThinkLong?: boolean
  effort?: string
  rolloutIds: string[]
}

export interface ChatCitationCard {
  cardId: string
  cardType?: string
  url?: string
}

export interface ChatInlineCitation {
  cardId: string
  citationId?: string
  url?: string
}

export interface ChatDeepSearchDetail {
  title: string
  bullets: string[]
}

export interface ChatDeepSearchResearchStep {
  tags: string[]
  title?: string
  text: string[]
  toolUsageCardIds?: string[]
  toolUsages?: ChatDeepSearchResearchStepToolUsage[]
}

export interface ChatDeepSearchResearchStepToolUsage {
  toolUsageCardId: string
  toolName: string
  args: Record<string, unknown>
  webSearchResults?: WebSearchResultItem[]
}

export interface ChatDeepSearchResearch {
  requestMetadata?: Record<string, unknown>
  uiLayout?: ChatReasoningLayout
  deepsearchPreset?: string
  thinkingStartTime?: string
  thinkingEndTime?: string
  details?: ChatDeepSearchDetail[]
  steps?: ChatDeepSearchResearchStep[]
  citationCards?: ChatCitationCard[]
  inlineCitations?: ChatInlineCitation[]
}

export interface ChatReasoningToolUsage {
  toolUsageCardId: string
  rolloutId?: string
  toolName: string
  args: Record<string, unknown>
  messageTag?: string
  isThinking?: boolean
  responseId?: string
}

export interface WebSearchResultItem {
  kind?: "web" | "x_post"
  title?: string
  url?: string
  preview?: string
  favicon?: string
  authorName?: string
  authorHandle?: string
  publishedAt?: string
  postId?: string
}

export interface ChatReasoningToolResult {
  toolUsageCardId?: string
  rolloutId?: string
  messageTag?: string
  webSearchResultsCount?: number
  webSearchResults?: WebSearchResultItem[]
  isThinking?: boolean
  responseId?: string
}

export interface ChatCardImagePayload {
  thumbnail?: string
  original?: string
  title?: string
  link?: string
  source?: string
}

export interface ChatCardAttachmentPayload {
  id: string
  cardType?: string
  type?: string
  url?: string
  assetId?: string
  asset_id?: string
  rawUrl?: string
  urlExpiresAt?: string
  image?: ChatCardImagePayload
}

export type ChatReasoningEventDetail =
  | {
      kind: "ui_layout"
      layout: ChatReasoningLayout
      isThinking?: boolean
      responseId?: string
    }
  | {
      kind: "tool_usage"
      usage: ChatReasoningToolUsage
    }
  | {
      kind: "tool_result"
      result: ChatReasoningToolResult
    }
  | {
      kind: "card_attachment"
      card: ChatCardAttachmentPayload
    }

export interface ChatTurnResult {
  assistantMessage: ChatMessage
  anchors: ChatAnchors
  usage?: ChatUsage
}

export interface ChatStreamEventMeta {
  seq: number
  ts: number
  conversationId: string
  responseId?: string
}

export type ChatStreamEvent =
  | {
      type: "started"
      requestId: string
      meta: ChatStreamEventMeta
    }
  | {
      type: "heartbeat"
      idleMs: number
      meta: ChatStreamEventMeta
    }
  | {
      type: "delta"
      textDelta: string
      meta: ChatStreamEventMeta
    }
  | {
      type: "reasoning"
      detail: ChatReasoningEventDetail
      meta: ChatStreamEventMeta
    }
  | {
      type: "completed"
      result: ChatTurnResult
      meta: ChatStreamEventMeta
    }
  | {
      type: "failed"
      code: string
      message: string
      meta: ChatStreamEventMeta
    }
