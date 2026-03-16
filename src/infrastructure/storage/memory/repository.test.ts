import { describe, expect, it } from "bun:test"
import { MemoryAppRepository } from "./repository"

describe("MemoryAppRepository", () => {
  it("toggles conversation starred without rewriting updatedAt", async () => {
    const repository = new MemoryAppRepository()
    await repository.upsertConversation({
      id: "conv_star_memory_1",
      title: "需要星标",
      starred: false,
      anchors: {
        conversationId: "conv_star_memory_1",
      },
      createdAt: 100,
      updatedAt: 200,
    })

    await repository.updateConversationStarred("conv_star_memory_1", true)

    const conversation = (await repository.listConversations()).find(
      (item) => item.id === "conv_star_memory_1"
    )
    expect(conversation?.starred).toBe(true)
    expect(conversation?.updatedAt).toBe(200)
  })
})
