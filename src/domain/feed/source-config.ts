import type { FeedSource } from "./types"

export interface FeedSourceConfig {
  source: FeedSource
  label: string
  accountHandle: string
  readerUrl: string
  fallbackTitle: string
}

export const FEED_SOURCES: FeedSource[] = ["polymarket", "kalshi"]

export const FEED_SOURCE_CONFIG: Record<FeedSource, FeedSourceConfig> = {
  polymarket: {
    source: "polymarket",
    label: "Polymarket",
    accountHandle: "Polymarket",
    readerUrl: "https://r.jina.ai/http://x.com/Polymarket",
    fallbackTitle: "Polymarket 更新",
  },
  kalshi: {
    source: "kalshi",
    label: "Kalshi",
    accountHandle: "Kalshi",
    readerUrl: "https://r.jina.ai/http://x.com/Kalshi",
    fallbackTitle: "Kalshi 更新",
  },
}

export function getFeedSourceConfig(source: FeedSource): FeedSourceConfig {
  return FEED_SOURCE_CONFIG[source]
}
