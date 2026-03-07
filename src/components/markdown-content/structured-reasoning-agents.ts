import type { AgentDescriptor, StructuredReasoningEntry } from "./types"
import { AGENT_PIXEL_PALETTES } from "./types"
import type { AgentGroupedEntries } from "./structured-reasoning-models"
import { parseAgentMeta } from "./think-parser"

function normalizeRolloutLabel(rolloutId: string): string {
  let label = rolloutId.trim()
  label = label.replace(/^Chat\s*Room\s*/i, "").trim()
  return label || "Grok"
}

export function collectRolloutAgents(rolloutIds: string[]): AgentDescriptor[] {
  const agents: AgentDescriptor[] = []
  const seen = new Set<string>()

  const append = (next: AgentDescriptor) => {
    if (seen.has(next.key)) {
      return
    }
    seen.add(next.key)
    agents.push(next)
  }

  append({
    key: "grok_primary",
    label: "NBSearch",
    paletteIndex: 0,
    isPrimary: true,
  })

  rolloutIds.forEach((rolloutId, index) => {
    const normalized = normalizeRolloutLabel(rolloutId)
    if (!normalized || normalized.toLowerCase() === "grok") {
      return
    }
    const known = parseAgentMeta(normalized, index)
    if (known) {
      append(known)
      return
    }
    append({
      key: normalized.toLowerCase().replace(/\s+/g, "_"),
      label: normalized,
      paletteIndex: (index + 1) % AGENT_PIXEL_PALETTES.length,
    })
  })

  return agents
}

export function groupEntriesByAgent(
  entries: StructuredReasoningEntry[],
  agents: AgentDescriptor[]
): AgentGroupedEntries[] {
  const result: AgentGroupedEntries[] = []
  let currentKey = ""
  let currentGroup: StructuredReasoningEntry[] = []

  const resolveAgent = (key: string): AgentDescriptor =>
    agents.find((a) => a.key === key) || {
      key,
      label: key === "grok_primary" ? "NBSearch" : key.replace(/_/g, " "),
      paletteIndex: 0,
    }

  const flush = () => {
    if (currentKey && currentGroup.length > 0) {
      result.push({ agent: resolveAgent(currentKey), entries: currentGroup })
    }
    currentGroup = []
  }

  for (const entry of entries) {
    const key = toAgentKey(entry.rolloutId)
    if (key !== currentKey) {
      flush()
      currentKey = key
    }
    currentGroup.push(entry)
  }
  flush()

  return result
}

export function toAgentKey(rolloutId: string): string {
  let normalized = rolloutId.trim().toLowerCase()
  normalized = normalized.replace(/^chat\s*room\s*/i, "").trim()
  if (!normalized || normalized === "grok") {
    return "grok_primary"
  }
  return normalized.replace(/\s+/g, "_")
}

export function resolveAgentDescriptorByKey(agents: AgentDescriptor[], key: string): AgentDescriptor {
  const found = agents.find((agent) => agent.key === key)
  if (found) {
    return found
  }
  return {
    key,
    label: key === "grok_primary" ? "NBSearch" : key.replace(/_/g, " "),
    paletteIndex: 0,
    isPrimary: key === "grok_primary",
  }
}
