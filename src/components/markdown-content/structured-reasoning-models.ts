import type { ChatDeepSearchResearch } from "@/domain/chat/types"
import type { AgentDescriptor, StructuredReasoningEntry } from "./types"

export type AgentGroupedEntries = {
  agent: AgentDescriptor
  entries: StructuredReasoningEntry[]
}

export type DeepSearchGroupedItem =
  | {
      kind: "summary"
      key: string
      rows: string[]
    }
  | {
      kind: "tool"
      key: string
      entries: StructuredReasoningEntry[]
    }

export type DeepSearchGroupedSection = {
  key: string
  title: string
  items: DeepSearchGroupedItem[]
}

export type DeepSearchTimelineItem =
  | {
      kind: "thought"
      key: string
      title: string
      bullets: string[]
    }
  | {
      kind: "tool"
      key: string
      entry: StructuredReasoningEntry
    }

export function hasDeepSearchContent(research: Pick<ChatDeepSearchResearch, "steps" | "details"> | undefined): boolean {
  if (!research) {
    return false
  }
  const steps = Array.isArray(research.steps) ? research.steps : []
  const details = Array.isArray(research.details) ? research.details : []
  return steps.length > 0 || details.length > 0
}

export function shouldShowResearchDetails(hasAgentItems: boolean, timelineCount: number): boolean {
  return !hasAgentItems && timelineCount === 0
}
