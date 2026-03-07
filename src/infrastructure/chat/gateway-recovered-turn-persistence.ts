import type { ChatAnchors, ChatMessage, ChatTurnResult } from "../../domain/chat/types"
import type { ConversationRecord } from "../../domain/storage/repository"
import type {
  GatewaySessionMessage,
  GatewaySessionState,
  GatewayTurnState,
} from "./gateway-session-recovery"

type PersistRecoveredCompletedTurnInput = {
  conversationId: string
  sessionId: string
  turnState: GatewayTurnState
  fallbackPreviousResponseId: string
  listMessages: () => Promise<ChatMessage[]>
  listConversations: () => Promise<ConversationRecord[]>
  updateMessage: (message: ChatMessage) => Promise<void>
  appendMessage: (message: ChatMessage) => Promise<void>
  upsertConversation: (record: ConversationRecord) => Promise<void>
  querySessionMessages: (afterResponseId: string) => Promise<GatewaySessionMessage[]>
  querySessionState: () => Promise<GatewaySessionState | null>
  createConversationRecord: (title: string, anchors: ChatAnchors, now: number) => ConversationRecord
  fallbackConversationTitleFromPrompt: (prompt: string) => string
  now?: () => number
  createAssistantMessageId?: () => string
}

function findRecoveredAssistantCandidate(
  rows: GatewaySessionMessage[],
  targetResponseId: string
): GatewaySessionMessage | undefined {
  return (
    rows.find((row) => row.role === "assistant" && row.responseId.trim() === targetResponseId) ||
    rows
      .filter((row) => row.role === "assistant")
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1)
  )
}

function buildRecoveredAssistantMessage(input: {
  existingAssistant?: ChatMessage
  candidate: GatewaySessionMessage
  targetResponseId: string
  fallbackPreviousResponseId: string
  createAssistantMessageId: () => string
}): ChatMessage {
  const { existingAssistant, candidate, targetResponseId, fallbackPreviousResponseId } = input
  return {
    id: existingAssistant?.id || candidate.id || targetResponseId || input.createAssistantMessageId(),
    role: "assistant",
    content: candidate.content || existingAssistant?.content || "",
    createdAt: existingAssistant?.createdAt || candidate.createdAt || Date.now(),
    responseId: targetResponseId,
    previousResponseId:
      candidate.previousResponseId ||
      existingAssistant?.previousResponseId ||
      fallbackPreviousResponseId ||
      undefined,
    status: "completed",
    reasoningEvents: existingAssistant?.reasoningEvents,
    reasoningDurationSeconds: existingAssistant?.reasoningDurationSeconds,
    research: existingAssistant?.research,
  }
}

export async function persistRecoveredCompletedTurnFromGateway(
  input: PersistRecoveredCompletedTurnInput
): Promise<ChatTurnResult | null> {
  const targetResponseId = input.turnState.responseId.trim()
  if (!targetResponseId) {
    return null
  }

  const fallbackPreviousResponseId = input.fallbackPreviousResponseId.trim()
  const recoveredRows = await input.querySessionMessages(fallbackPreviousResponseId)
  const candidate = findRecoveredAssistantCandidate(recoveredRows, targetResponseId)
  if (!candidate) {
    return null
  }

  const existingMessages = await input.listMessages()
  const existingAssistant = existingMessages.find(
    (row) => row.role === "assistant" && (row.responseId || "").trim() === targetResponseId
  )
  const nextAssistant = buildRecoveredAssistantMessage({
    existingAssistant,
    candidate,
    targetResponseId,
    fallbackPreviousResponseId,
    createAssistantMessageId: input.createAssistantMessageId || (() => `asst_${crypto.randomUUID()}`),
  })

  if (existingAssistant) {
    const shouldUpdate =
      existingAssistant.content !== nextAssistant.content ||
      (existingAssistant.previousResponseId || "") !== (nextAssistant.previousResponseId || "") ||
      (existingAssistant.status || "completed") !== "completed"
    if (shouldUpdate) {
      await input.updateMessage(nextAssistant)
    }
  } else {
    await input.appendMessage(nextAssistant)
  }

  const sessionState = await input.querySessionState()
  const existingConversations = await input.listConversations()
  const currentConversation = existingConversations.find((item) => item.id === input.conversationId)
  const currentTitle = currentConversation?.title || ""
  const anchors: ChatAnchors = {
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    lastResponseId: sessionState?.lastResponseId.trim() || targetResponseId || fallbackPreviousResponseId,
  }
  const now = input.now || (() => Date.now())
  await input.upsertConversation(
    input.createConversationRecord(
      currentTitle || input.fallbackConversationTitleFromPrompt(nextAssistant.content),
      anchors,
      now()
    )
  )

  return {
    assistantMessage: nextAssistant,
    anchors,
  }
}
