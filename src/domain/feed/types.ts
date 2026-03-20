export type FeedSource = "polymarket" | "kalshi"
export type FeedItemTranslationStatus = "translated" | "skipped" | "failed"

export interface FeedSubscriptionRecord {
  id: string
  source: FeedSource
  enabled: boolean
  pollIntervalMinutes: number
  lastPolledAt: number | null
  lastSuccessAt: number | null
  lastError: string
  createdAt: number
  updatedAt: number
}

export interface FeedItemRecord {
  id: string
  subscriptionId: string
  source: FeedSource
  contentHash: string
  title: string
  contentMarkdown: string
  titleZh: string
  contentMarkdownZh: string
  translationStatus: FeedItemTranslationStatus
  translationModel: string
  translatedAt: number | null
  mediaUrls: string[]
  canonicalUrl: string
  publishedAt: number | null
  discoveredAt: number
  fetchedAt: number
}

export interface FeedPageCursor {
  discoveredAt: number
  id: string
}

export interface FeedPage<T> {
  items: T[]
  nextCursor: FeedPageCursor | null
}

export interface FeedSyncResult {
  source: FeedSource
  fetchedAt: number
  insertedCount: number
  parsedCount: number
}
