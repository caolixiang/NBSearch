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

  it("lists pending feed translations and updates them in place", async () => {
    const repository = new MemoryAppRepository()
    await repository.insertFeedItems([
      {
        id: "feed_1",
        subscriptionId: "feed_sub_polymarket",
        source: "polymarket",
        contentHash: "hash_1",
        title: "Original title",
        contentMarkdown: "Original body",
        titleZh: "",
        contentMarkdownZh: "",
        translationStatus: "failed",
        translationModel: "gpt-5.4-mini",
        translatedAt: null,
        mediaUrls: [],
        canonicalUrl: "https://x.com/Polymarket/status/1",
        publishedAt: null,
        discoveredAt: 200,
        fetchedAt: 200,
      },
    ])

    const pending = await repository.listFeedItemsNeedingTranslation({
      source: "polymarket",
      limit: 10,
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe("feed_1")

    const updated = await repository.updateFeedItemTranslations([
      {
        id: "feed_1",
        titleZh: "中文标题",
        contentMarkdownZh: "中文正文",
        translationStatus: "translated",
        translationModel: "gpt-5.4-mini",
        translatedAt: 300,
      },
    ])
    expect(updated).toBe(1)

    const afterUpdate = await repository.listFeedItemsNeedingTranslation({
      source: "polymarket",
      limit: 10,
    })
    expect(afterUpdate).toHaveLength(0)
  })
})
