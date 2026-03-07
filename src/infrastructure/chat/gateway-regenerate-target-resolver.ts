import type { ChatMessage } from "../../domain/chat/types"
import type { GatewaySessionMessage } from "./gateway-session-recovery"

export type GatewayResolvedRegenerateTarget = {
  targetMessage: ChatMessage | null
  matchedAssistant: GatewaySessionMessage | null
  resolvedResponseId: string
  resolvedPreviousResponseId: string
}

export function resolveGatewayRegenerateTarget(input: {
  localMessages: ChatMessage[]
  sessionMessages: GatewaySessionMessage[]
  messageId: string
}): GatewayResolvedRegenerateTarget {
  const messageId = input.messageId.trim()
  if (!messageId) {
    return {
      targetMessage: null,
      matchedAssistant: null,
      resolvedResponseId: "",
      resolvedPreviousResponseId: "",
    }
  }

  const targetMessage = input.localMessages.find(
    (row) => row.id === messageId && row.role === "assistant"
  )
  if (!targetMessage || targetMessage.role !== "assistant") {
    return {
      targetMessage: null,
      matchedAssistant: null,
      resolvedResponseId: "",
      resolvedPreviousResponseId: "",
    }
  }

  if (input.sessionMessages.length === 0) {
    return {
      targetMessage,
      matchedAssistant: null,
      resolvedResponseId: targetMessage.responseId?.trim() || "",
      resolvedPreviousResponseId: targetMessage.previousResponseId?.trim() || "",
    }
  }

  const localRenderableMessages = input.localMessages.filter(
    (row) => row.role === "user" || row.role === "assistant"
  )
  const sessionRenderableMessages = input.sessionMessages.filter(
    (row) => row.role === "user" || row.role === "assistant"
  )

  let matchedAssistant: GatewaySessionMessage | null = null
  const targetRenderableIndex = localRenderableMessages.findIndex((row) => row.id === messageId)
  const hasMatchingRoleShape =
    targetRenderableIndex >= 0 &&
    localRenderableMessages.length === sessionRenderableMessages.length &&
    localRenderableMessages.every((row, index) => row.role === sessionRenderableMessages[index]?.role)

  if (hasMatchingRoleShape) {
    const candidate = sessionRenderableMessages[targetRenderableIndex]
    if (candidate?.role === "assistant") {
      matchedAssistant = candidate
    }
  }

  if (!matchedAssistant) {
    const localAssistants = localRenderableMessages.filter((row) => row.role === "assistant")
    const sessionAssistants = sessionRenderableMessages.filter((row) => row.role === "assistant")
    const targetAssistantIndex = localAssistants.findIndex((row) => row.id === messageId)
    if (targetAssistantIndex >= 0 && targetAssistantIndex < sessionAssistants.length) {
      matchedAssistant = sessionAssistants[targetAssistantIndex] || null
    }
  }

  if (!matchedAssistant) {
    const targetContent = targetMessage.content.trim()
    if (targetContent) {
      const exactContentMatches = sessionRenderableMessages.filter(
        (row) => row.role === "assistant" && row.content.trim() === targetContent
      )
      if (exactContentMatches.length === 1) {
        matchedAssistant = exactContentMatches[0] || null
      }
    }
  }

  return {
    targetMessage,
    matchedAssistant,
    resolvedResponseId: matchedAssistant?.responseId.trim() || targetMessage.responseId?.trim() || "",
    resolvedPreviousResponseId:
      matchedAssistant?.previousResponseId.trim() || targetMessage.previousResponseId?.trim() || "",
  }
}
