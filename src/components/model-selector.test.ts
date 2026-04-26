import { describe, expect, it } from "bun:test"
import type { ModelOption } from "@/domain/models/types"
import { resolveModelDisplayName } from "./model-selector"

function model(partial: Partial<ModelOption> & Pick<ModelOption, "id">): ModelOption {
  return {
    id: partial.id,
    name: partial.name || partial.id,
    shortName: partial.shortName || partial.id,
    provider: partial.provider || "xAI",
    description: partial.description || "",
    visualKind: partial.visualKind || "default",
  }
}

describe("resolveModelDisplayName", () => {
  it("keeps gateway-synced NBSearch tiers distinct", () => {
    expect(
      resolveModelDisplayName(
        model({
          id: "grok-4.1-fast",
          description: "低延迟会话模式",
          visualKind: "speed",
        })
      )
    ).toBe("NBSearch Fast")

    expect(
      resolveModelDisplayName(
        model({
          id: "grok-4.20-0309-reasoning",
          description: "更强推理与复杂任务",
          visualKind: "reasoning",
        })
      )
    ).toBe("NBSearch Expert")

    expect(
      resolveModelDisplayName(
        model({
          id: "grok-4.20-expert",
          description: "最新实验模型",
          visualKind: "spark",
        })
      )
    ).toBe("NBSearch Max")
  })

  it("keeps unknown model names unchanged", () => {
    expect(resolveModelDisplayName(model({ id: "custom-model", name: "Custom Model" }))).toBe("Custom Model")
  })
})
