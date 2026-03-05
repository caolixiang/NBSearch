import { describe, expect, it } from "bun:test"
import { normalizeRemoteModelList, resolveSelectedModel } from "./catalog"

describe("normalizeRemoteModelList", () => {
  it("parses /v1/models/tauri_chat_models payload and keeps order", () => {
    const payload = {
      object: "list",
      data: [
        { id: "grok-4.1-fast", type: "fast" },
        { id: "grok-4.1-fast", type: "fast" },
      ],
    }

    const models = normalizeRemoteModelList(payload)
    expect(models.map((item) => item.id)).toEqual(["grok-4.1-fast"])
    expect(models[0]?.description).toBe("低延迟会话模式")
    expect(models[0]?.shortName).toBe("Grok 4.1")
  })

  it("returns empty list for invalid payload", () => {
    expect(normalizeRemoteModelList({ data: "invalid" })).toEqual([])
    expect(normalizeRemoteModelList(null)).toEqual([])
  })
})

describe("resolveSelectedModel", () => {
  it("picks the first valid candidate and falls back to first model", () => {
    const models = normalizeRemoteModelList({
      data: [{ id: "grok-4.1-fast", type: "fast" }, { id: "grok-4.1-expert", type: "expert" }],
    })

    expect(resolveSelectedModel(models, ["missing", "grok-4.1-expert"])).toBe("grok-4.1-expert")
    expect(resolveSelectedModel(models, ["missing"])).toBe("grok-4.1-fast")
  })
})
