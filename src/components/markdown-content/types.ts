import type { WebSearchResultItem } from "@/domain/chat/types"

export type TextSection = {
  type: "text"
  value: string
}

export type ThinkSection = {
  type: "think"
  value: string
  open: boolean
  thinking: boolean
}

export type MarkdownSection = TextSection | ThinkSection

export type ThinkItem = {
  type: string
  body: string
}

export type AgentDescriptor = {
  key: string
  label: string
  paletteIndex: number
  isPrimary?: boolean
}

export type ThinkTimelineEntry =
  | {
      kind: "websearch"
      key: string
      text: string
      visited: boolean
      resultsCount?: number
    }
  | {
      kind: "agent"
      key: string
      body: string
      agentKey: string
      agentLabel: string
      paletteIndex: number
    }
  | {
      kind: "other"
      key: string
      label: string
      body: string
    }

export const AGENT_PIXEL_PALETTES = [
  ["#111827", "#374151", "#6b7280", "#d1d5db"],
  ["#422006", "#78350f", "#d97706", "#fde68a"],
  ["#0f172a", "#1e293b", "#475569", "#cbd5e1"],
  ["#3f3f46", "#52525b", "#71717a", "#d4d4d8"],
] as const

export const AGENT_STACK_RING_COLORS = ["#9ca3af", "#a3a3a3", "#b45309", "#64748b", "#52525b", "#a8a29e"] as const

export type WebSearchToolMeta = {
  query: string
  numResults: number
}

export type ImageCardMeta = {
  id: string
  cardType?: string
  type?: string
  url?: string
  assetId?: string
  rawUrl?: string
  urlExpiresAt?: string
  image?: {
    thumbnail?: string
    original?: string
    title?: string
    link?: string
    source?: string
  }
  thumbnail?: string
  original?: string
  title?: string
  link?: string
  source?: string
}

export type AssistantToolMeta = {
  webSearch: WebSearchToolMeta[]
  cards: Record<string, ImageCardMeta>
}

export type StructuredReasoningEntry = {
  key: string
  toolUsageCardId: string
  rolloutId: string
  text: string
  visited: boolean
  toolName: string
  resultsCount?: number
  webSearchResults?: WebSearchResultItem[]
  status: "running" | "completed"
}

export type StructuredReasoningToolChainItem = {
  toolName: string
  usageCount: number
  completedCount: number
  runningCount: number
}

export type StructuredReasoningSummary = {
  entries: StructuredReasoningEntry[]
  rolloutIds: string[]
  toolChain: StructuredReasoningToolChainItem[]
}

export type ToolJsonLineRewrite =
  | {
      kind: "keep"
      line: string
    }
  | {
      kind: "drop"
    }
