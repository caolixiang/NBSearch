import type { ModelOption } from "@/domain/models/types"

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

export function resolveDeepSearchExpertModelId(models: ModelOption[], fallbackModelId: string): string {
  const fallback = fallbackModelId || models[0]?.id || ""
  if (models.length === 0) {
    return fallback
  }

  const withExpertKeyword = models.filter((item) => buildSearchText(item).includes("expert"))
  const expertId = pickPreferredGrokOrFirst(withExpertKeyword)
  if (expertId) {
    return expertId
  }

  const reasoningModels = models.filter((item) => item.visualKind === "reasoning")
  const reasoningId = pickPreferredGrokOrFirst(reasoningModels)
  if (reasoningId) {
    return reasoningId
  }

  const grokNonFast = models.find((item) => {
    const id = item.id.toLowerCase()
    return id.includes("grok") && !id.includes("fast")
  })
  if (grokNonFast) {
    return grokNonFast.id
  }

  return fallback
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

