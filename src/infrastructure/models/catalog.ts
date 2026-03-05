import type { AppConfig } from "../../app/contracts"
import type { ModelOption, ModelVisualKind } from "../../domain/models/types"
import { normalizeGatewayBaseUrl } from "../chat/grok-chat-service"
import { runtimeFetch } from "../http/runtime-fetch"

const MODEL_OPTIONS_STORAGE_KEY = "chat-app:model-options:v1"
const SELECTED_MODEL_STORAGE_KEY = "chat-app:selected-model:v1"

type RemoteModelRecord = Record<string, unknown>

const TYPE_DESCRIPTIONS: Record<string, string> = {
  fast: "低延迟会话模式",
  expert: "更强推理与复杂任务",
  latest: "最新实验模型",
}

export const DEFAULT_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    shortName: "Claude Sonnet 4.5",
    provider: "Anthropic",
    description: "智能与速度的最佳平衡",
    visualKind: "speed",
  },
  {
    id: "anthropic/claude-opus-4-1",
    name: "Claude Opus 4.1",
    shortName: "Claude Opus 4.1",
    provider: "Anthropic",
    description: "最强推理能力",
    visualKind: "reasoning",
  },
  {
    id: "grok-4.1-fast",
    name: "Grok 4.1 Fast",
    shortName: "Grok 4.1",
    provider: "xAI",
    description: "低延迟会话模式",
    visualKind: "spark",
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function mergeVersionTokens(tokens: string[]): string[] {
  const merged: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]
    const next = tokens[index + 1]
    if (/^\d+$/.test(current) && typeof next === "string" && /^\d+$/.test(next)) {
      merged.push(`${current}.${next}`)
      index += 1
      continue
    }
    merged.push(current)
  }
  return merged
}

function humanizeToken(token: string): string {
  const lower = token.toLowerCase()
  if (lower === "gpt") {
    return "GPT"
  }
  if (lower === "grok") {
    return "Grok"
  }
  if (lower === "claude") {
    return "Claude"
  }
  if (/^\d/.test(token)) {
    return token
  }
  return token.charAt(0).toUpperCase() + token.slice(1)
}

function humanizeModelId(id: string): string {
  const normalized = id.split("/").pop() ?? id
  const tokens = mergeVersionTokens(normalized.split("-").filter(Boolean))
  return tokens.map(humanizeToken).join(" ")
}

function inferProvider(id: string, raw: RemoteModelRecord): string {
  const provider = raw.provider
  if (typeof provider === "string" && provider.trim()) {
    return provider.trim()
  }
  const ownedBy = raw.owned_by
  if (typeof ownedBy === "string" && ownedBy.trim()) {
    return ownedBy.trim()
  }
  if (id.startsWith("anthropic/") || id.includes("claude")) {
    return "Anthropic"
  }
  if (id.startsWith("openai/") || id.includes("gpt")) {
    return "OpenAI"
  }
  if (id.includes("grok")) {
    return "xAI"
  }
  return "Gateway"
}

function inferVisualKind(id: string, type: string): ModelVisualKind {
  const normalizedId = id.toLowerCase()
  const normalizedType = type.toLowerCase()
  if (normalizedId.includes("claude-opus") || normalizedType === "expert") {
    return "reasoning"
  }
  if (normalizedId.includes("claude-sonnet") || normalizedType === "fast") {
    return "speed"
  }
  if (normalizedId.includes("gpt")) {
    return "compute"
  }
  if (normalizedId.includes("grok")) {
    return "spark"
  }
  return "default"
}

function inferDescription(id: string, raw: RemoteModelRecord): string {
  const description = raw.description
  if (typeof description === "string" && description.trim()) {
    return description.trim()
  }

  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : ""
  if (TYPE_DESCRIPTIONS[type]) {
    return TYPE_DESCRIPTIONS[type]
  }

  const normalizedId = id.toLowerCase()
  if (normalizedId.includes("claude-sonnet")) {
    return "智能与速度的最佳平衡"
  }
  if (normalizedId.includes("claude-opus")) {
    return "最强推理能力"
  }
  return "可用于当前聊天会话"
}

function inferShortName(id: string, name: string, raw: RemoteModelRecord): string {
  const shortName = raw.short_name ?? raw.shortName
  if (typeof shortName === "string" && shortName.trim()) {
    return shortName.trim()
  }

  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : ""
  if (type === "fast" && name.endsWith(" Fast")) {
    return name.slice(0, -" Fast".length)
  }

  if (id.includes("claude") || id.includes("gpt")) {
    return name
  }

  return name
}

function normalizeStoredModelOption(value: unknown): ModelOption | null {
  if (!isRecord(value)) {
    return null
  }

  const { id, name, shortName, provider, description, visualKind } = value
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof shortName !== "string" ||
    typeof provider !== "string" ||
    typeof description !== "string" ||
    typeof visualKind !== "string"
  ) {
    return null
  }

  const allowedKinds: ModelVisualKind[] = ["speed", "reasoning", "spark", "compute", "default"]
  if (!allowedKinds.includes(visualKind as ModelVisualKind)) {
    return null
  }

  return {
    id,
    name,
    shortName,
    provider,
    description,
    visualKind: visualKind as ModelVisualKind,
  }
}

function normalizeRemoteModel(value: unknown): ModelOption | null {
  if (!isRecord(value)) {
    return null
  }

  const id = typeof value.id === "string" ? value.id.trim() : ""
  if (!id) {
    return null
  }

  const rawName = value.display_name ?? value.name
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : humanizeModelId(id)
  const type = typeof value.type === "string" ? value.type.trim() : ""

  return {
    id,
    name,
    shortName: inferShortName(id, name, value),
    provider: inferProvider(id, value),
    description: inferDescription(id, value),
    visualKind: inferVisualKind(id, type),
  }
}

export function normalizeRemoteModelList(payload: unknown): ModelOption[] {
  const rawList = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : []

  const seen = new Set<string>()
  const models: ModelOption[] = []

  for (const item of rawList) {
    const normalized = normalizeRemoteModel(item)
    if (!normalized || seen.has(normalized.id)) {
      continue
    }
    seen.add(normalized.id)
    models.push(normalized)
  }

  return models
}

export function readStoredModelOptions(): ModelOption[] {
  if (!hasLocalStorage()) {
    return []
  }

  try {
    const raw = window.localStorage.getItem(MODEL_OPTIONS_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map(normalizeStoredModelOption)
      .filter((item): item is ModelOption => item !== null)
  } catch {
    return []
  }
}

export function persistModelOptions(models: ModelOption[]): void {
  if (!hasLocalStorage()) {
    return
  }
  window.localStorage.setItem(MODEL_OPTIONS_STORAGE_KEY, JSON.stringify(models))
}

export function readStoredSelectedModel(): string {
  if (!hasLocalStorage()) {
    return ""
  }
  return window.localStorage.getItem(SELECTED_MODEL_STORAGE_KEY)?.trim() || ""
}

export function persistSelectedModel(modelId: string): void {
  if (!hasLocalStorage()) {
    return
  }
  window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, modelId.trim())
}

export function resolveSelectedModel(models: ModelOption[], candidates: Array<string | undefined>): string {
  const ids = new Set(models.map((model) => model.id))
  for (const candidate of candidates) {
    const normalized = candidate?.trim()
    if (normalized && ids.has(normalized)) {
      return normalized
    }
  }
  return models[0]?.id || ""
}

export async function fetchRemoteModelOptions(config: AppConfig): Promise<ModelOption[]> {
  const response = await runtimeFetch(`${normalizeGatewayBaseUrl(config.apiBaseUrl)}/models/tauri_chat_models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
  })

  if (!response.ok) {
    throw new Error(`model_catalog_error:${response.status}`)
  }

  const payload = await response.json()
  const models = normalizeRemoteModelList(payload)
  if (models.length === 0) {
    throw new Error("model_catalog_empty")
  }
  return models
}
