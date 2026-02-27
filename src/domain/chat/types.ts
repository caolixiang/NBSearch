export type ChatMessageRole = "system" | "user" | "assistant" | "tool"

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  content: string
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
      type: "completed"
      result: ChatTurnResult
    }
  | {
      type: "failed"
      code: string
      message: string
    }
