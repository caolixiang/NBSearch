import { describe, expect, it } from "bun:test"
import type { ModelOption } from "@/domain/models/types"
import {
  resolveActiveQuickModelPresetId,
  buildQuickModelPresets,
  resolveFastModelId,
  resolveQuickModelPresetId,
  resolveThinkerModelId,
  shouldCollapseQuickModelSwitch,
} from "./model-selection"

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

describe("resolveThinkerModelId", () => {
  it("prefers expert and reasoning models", () => {
    const models: ModelOption[] = [
      model({ id: "claude-sonnet", visualKind: "speed" }),
      model({ id: "claude-opus", visualKind: "reasoning" }),
      model({ id: "grok-fast", visualKind: "spark" }),
    ]
    expect(resolveThinkerModelId(models, "claude-sonnet")).toBe("claude-opus")
  })
})

describe("buildQuickModelPresets", () => {
  it("builds fast thinker max shortcuts in order", () => {
    const models: ModelOption[] = [
      model({ id: "claude-sonnet", visualKind: "speed" }),
      model({ id: "claude-opus", visualKind: "reasoning" }),
      model({ id: "grok-4.20-latest", visualKind: "spark" }),
    ]

    expect(buildQuickModelPresets(models, "claude-sonnet")).toEqual([
      {
        id: "fast",
        label: "极速",
        description: "快速响应",
        modelId: "claude-sonnet",
      },
      {
        id: "thinker",
        label: "专家",
        description: "深度思考",
        modelId: "claude-opus",
      },
      {
        id: "max",
        label: "实验性",
        description: "多代理",
        modelId: "grok-4.20-latest",
      },
    ])
  })
})

describe("resolveQuickModelPresetId", () => {
  it("maps selected models onto quick model presets", () => {
    const models: ModelOption[] = [
      model({ id: "claude-sonnet", visualKind: "speed" }),
      model({ id: "claude-opus", visualKind: "reasoning" }),
      model({ id: "gpt-5", visualKind: "compute" }),
    ]

    expect(resolveQuickModelPresetId(models, "claude-sonnet")).toBe("fast")
    expect(resolveQuickModelPresetId(models, "claude-opus")).toBe("thinker")
    expect(resolveQuickModelPresetId(models, "gpt-5")).toBe("max")
  })
})

describe("resolveActiveQuickModelPresetId", () => {
  it("prefers exact preset model mapping before keyword inference", () => {
    const models: ModelOption[] = [
      model({ id: "claude-sonnet", visualKind: "speed" }),
      model({ id: "claude-opus", visualKind: "reasoning" }),
      model({ id: "grok-4.1-expert", visualKind: "spark", description: "Best quality" }),
    ]

    const presets = [
      {
        id: "fast" as const,
        label: "极速",
        description: "快速响应",
        modelId: "claude-sonnet",
      },
      {
        id: "thinker" as const,
        label: "专家",
        description: "深度思考",
        modelId: "claude-opus",
      },
      {
        id: "max" as const,
        label: "实验性",
        description: "多代理",
        modelId: "grok-4.1-expert",
      },
    ]

    expect(resolveQuickModelPresetId(models, "grok-4.1-expert")).toBe("thinker")
    expect(resolveActiveQuickModelPresetId(presets, models, "grok-4.1-expert")).toBe("max")
  })
})

describe("shouldCollapseQuickModelSwitch", () => {
  it("collapses for long text, multiline text, or attachments", () => {
    expect(shouldCollapseQuickModelSwitch("short text", 0)).toBe(false)
    expect(shouldCollapseQuickModelSwitch("这是一段足够长的输入文本用于收起模型快捷切换", 0)).toBe(true)
    expect(shouldCollapseQuickModelSwitch("line1\nline2", 0)).toBe(true)
    expect(shouldCollapseQuickModelSwitch("", 1)).toBe(true)
  })
})
