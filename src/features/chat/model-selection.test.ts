import { describe, expect, it } from "bun:test"
import type { ModelOption } from "@/domain/models/types"
import { resolveDeepSearchExpertModelId, resolveFastModelId } from "./model-selection"

function model(partial: Partial<ModelOption> & Pick<ModelOption, "id">): ModelOption {
  return {
    id: partial.id,
    name: partial.name || partial.id,
    shortName: partial.shortName || partial.id,
    provider: partial.provider || "xai",
    description: partial.description || "",
    visualKind: partial.visualKind || "default",
  }
}

describe("resolveDeepSearchExpertModelId", () => {
  it("prefers expert keyword model", () => {
    const models: ModelOption[] = [
      model({ id: "grok-4.1-fast", visualKind: "speed" }),
      model({ id: "grok-4.1-expert", visualKind: "reasoning", description: "expert mode" }),
    ]
    expect(resolveDeepSearchExpertModelId(models, "grok-4.1-fast")).toBe("grok-4.1-expert")
  })

  it("falls back to reasoning model when no expert keyword", () => {
    const models: ModelOption[] = [
      model({ id: "grok-4.1-fast", visualKind: "speed" }),
      model({ id: "grok-4.1", visualKind: "reasoning" }),
    ]
    expect(resolveDeepSearchExpertModelId(models, "grok-4.1-fast")).toBe("grok-4.1")
  })
})

describe("resolveFastModelId", () => {
  it("prefers fast keyword model", () => {
    const models: ModelOption[] = [
      model({ id: "grok-4.1", visualKind: "reasoning" }),
      model({ id: "grok-4.1-fast", visualKind: "speed" }),
    ]
    expect(resolveFastModelId(models, "grok-4.1")).toBe("grok-4.1-fast")
  })

  it("falls back to speed model when no fast keyword", () => {
    const models: ModelOption[] = [
      model({ id: "grok-4.1", visualKind: "reasoning" }),
      model({ id: "speed-default", visualKind: "speed" }),
    ]
    expect(resolveFastModelId(models, "grok-4.1")).toBe("speed-default")
  })
})

