import type { ModelOption } from "@/domain/models/types"

export type QuickModelPresetId = "fast" | "thinker" | "max"

export interface QuickModelPreset {
  id: QuickModelPresetId
  label: string
  description: string
  modelId: string
}

function buildSearchText(model: ModelOption): string {
  return `${model.id} ${model.name} ${model.shortName} ${model.description}`.toLowerCase()
}

function pickPreferredGrokOrFirst(list: ModelOption[]): string {
  if (list.length === 0) {
    return ""
  }
  const grok = list.find((item) => item.id.toLowerCase().includes("grok"))
  return (grok || list[0]).id
}

function hasAnyKeyword(model: ModelOption, keywords: string[]): boolean {
  const text = buildSearchText(model)
  return keywords.some((keyword) => text.includes(keyword))
}

function resolvePreferredModelId(
  models: ModelOption[],
  keywords: string[],
  fallbackModelId: string,
  excludedIds: Set<string> = new Set(),
  visualKinds: ModelOption["visualKind"][] = []
): string {
  const available = models.filter((item) => !excludedIds.has(item.id))
  if (available.length === 0) {
    return fallbackModelId
  }

  const keywordMatches = available.filter((item) => hasAnyKeyword(item, keywords))
  const keywordId = pickPreferredGrokOrFirst(keywordMatches)
  if (keywordId) {
    return keywordId
  }

  if (visualKinds.length > 0) {
    const kindMatches = available.filter((item) => visualKinds.includes(item.visualKind))
    const kindId = pickPreferredGrokOrFirst(kindMatches)
    if (kindId) {
      return kindId
    }
  }

  const fallback = available.find((item) => item.id === fallbackModelId)?.id
  if (fallback) {
    return fallback
  }

  return available[0]?.id || fallbackModelId
}

export function resolveFastModelId(models: ModelOption[], fallbackModelId: string): string {
  const fallback = fallbackModelId || models[0]?.id || ""
  if (models.length === 0) {
    return fallback
  }

  const withFastKeyword = models.filter((item) => buildSearchText(item).includes("fast"))
  const fastId = pickPreferredGrokOrFirst(withFastKeyword)
  if (fastId) {
    return fastId
  }

  const speedModels = models.filter((item) => item.visualKind === "speed")
  const speedId = pickPreferredGrokOrFirst(speedModels)
  if (speedId) {
    return speedId
  }

  return fallback
}

export function resolveThinkerModelId(models: ModelOption[], fallbackModelId: string): string {
  const fallback = fallbackModelId || models[0]?.id || ""
  return resolvePreferredModelId(
    models,
    ["think", "expert", "reason", "opus"],
    fallback,
    new Set(),
    ["reasoning"]
  )
}

export function resolveMaxModelId(
  models: ModelOption[],
  fallbackModelId: string,
  excludedIds: Set<string> = new Set()
): string {
  const fallback = fallbackModelId || models[0]?.id || ""
  return resolvePreferredModelId(
    models,
    ["max", "latest", "heavy", "4.20", "4-20", "gpt", "compute"],
    fallback,
    excludedIds,
    ["spark", "compute", "default"]
  )
}

export function resolveQuickModelPresetId(models: ModelOption[], selectedModelId: string): QuickModelPresetId {
  const selected = models.find((item) => item.id === selectedModelId)
  if (!selected) {
    return "fast"
  }
  if (hasAnyKeyword(selected, ["fast"]) || selected.visualKind === "speed") {
    return "fast"
  }
  if (hasAnyKeyword(selected, ["think", "expert", "reason", "opus"]) || selected.visualKind === "reasoning") {
    return "thinker"
  }
  return "max"
}

export function buildQuickModelPresets(models: ModelOption[], fallbackModelId: string): QuickModelPreset[] {
  const fallback = fallbackModelId || models[0]?.id || ""
  if (!fallback) {
    return []
  }

  const fastId = resolveFastModelId(models, fallback)
  const thinkerId = resolveThinkerModelId(models, fallback)
  const maxId = resolveMaxModelId(models, fallback, new Set([fastId, thinkerId].filter(Boolean)))

  const presets: QuickModelPreset[] = [
    {
      id: "fast" as const,
      label: "Fast",
      description: "Quick responses",
      modelId: fastId,
    },
    {
      id: "thinker" as const,
      label: "Thinker",
      description: "Deeper reasoning",
      modelId: thinkerId,
    },
    {
      id: "max" as const,
      label: "Max",
      description: "Best quality",
      modelId: maxId,
    },
  ].filter((item) => item.modelId)

  const seenModelIds = new Set<string>()
  return presets.filter((item) => {
    if (seenModelIds.has(item.modelId)) {
      return false
    }
    seenModelIds.add(item.modelId)
    return true
  })
}

export function shouldCollapseQuickModelSwitch(input: string, attachmentCount: number): boolean {
  const normalizedInput = input.trim()
  return attachmentCount > 0 || normalizedInput.includes("\n") || normalizedInput.length >= 18
}
