import type {
  ChatReasoningEventDetail,
  ChatStreamEvent,
  ChatStreamEventMeta,
  ChatTurnResult,
} from "../../domain/chat/types"

export type GatewayStreamEventEmitterState = {
  gatewayResponseId: string
  streamEventSeq: number
}

export function createGatewayStreamEventEmitter(input: {
  conversationId: string
  onEvent: (event: ChatStreamEvent) => void
  now?: () => number
  initialState?: Partial<GatewayStreamEventEmitterState>
}): {
  state: GatewayStreamEventEmitterState
  setGatewayResponseId: (responseId: string) => void
  emitStarted: (requestId: string) => void
  emitDelta: (textDelta: string, responseId?: string) => void
  emitReasoning: (detail: ChatReasoningEventDetail, responseId?: string) => void
  emitHeartbeat: (idleMs: number, responseId?: string) => void
  emitCompleted: (result: ChatTurnResult, responseId?: string) => void
  emitFailed: (code: string, message: string, responseId?: string) => void
} {
  const now = input.now || (() => Date.now())
  const state: GatewayStreamEventEmitterState = {
    gatewayResponseId: input.initialState?.gatewayResponseId?.trim() || "",
    streamEventSeq: input.initialState?.streamEventSeq ?? 0,
  }

  const setGatewayResponseId = (responseId: string) => {
    const normalized = responseId.trim()
    if (!normalized) {
      return
    }
    state.gatewayResponseId = normalized
  }

  const nextStreamMeta = (responseId?: string): ChatStreamEventMeta => {
    state.streamEventSeq += 1
    const meta: ChatStreamEventMeta = {
      seq: state.streamEventSeq,
      ts: now(),
      conversationId: input.conversationId,
    }
    const explicitResponseId = responseId?.trim() || ""
    if (explicitResponseId) {
      state.gatewayResponseId = explicitResponseId
    }
    const normalizedResponseId = explicitResponseId || state.gatewayResponseId.trim()
    if (normalizedResponseId) {
      meta.responseId = normalizedResponseId
    }
    return meta
  }

  return {
    state,
    setGatewayResponseId,
    emitStarted: (requestId) => {
      input.onEvent({
        type: "started",
        requestId,
        meta: nextStreamMeta(),
      })
    },
    emitDelta: (textDelta, responseId) => {
      input.onEvent({
        type: "delta",
        textDelta,
        meta: nextStreamMeta(responseId),
      })
    },
    emitReasoning: (detail, responseId) => {
      input.onEvent({
        type: "reasoning",
        detail,
        meta: nextStreamMeta(responseId),
      })
    },
    emitHeartbeat: (idleMs, responseId) => {
      input.onEvent({
        type: "heartbeat",
        idleMs,
        meta: nextStreamMeta(responseId),
      })
    },
    emitCompleted: (result, responseId) => {
      input.onEvent({
        type: "completed",
        result,
        meta: nextStreamMeta(responseId),
      })
    },
    emitFailed: (code, message, responseId) => {
      input.onEvent({
        type: "failed",
        code,
        message,
        meta: nextStreamMeta(responseId),
      })
    },
  }
}
