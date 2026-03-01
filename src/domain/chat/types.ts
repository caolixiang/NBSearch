export type ChatMessageRole = "system" | "user" | "assistant" | "tool"

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningDurationSeconds?: number
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
  anchors: Partial<ChatAnchors>
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
  title?: string
  url?: string
  preview?: string
  favicon?: string
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

export type ChatStreamEvent =
  | {
      type: "started"
      requestId: string
    }
  | {
      type: "delta"
      textDelta: string
    }
  | {
      type: "reasoning"
      detail: ChatReasoningEventDetail
    }
  | {
      type: "completed"
      result: ChatTurnResult
    }
  | {
      type: "failed"
      code: string
      message: string
    }
