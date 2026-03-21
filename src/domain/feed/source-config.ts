import type { FeedSource } from "./types"

export interface FeedSourceConfig {
  source: FeedSource
  label: string
  accountHandle: string
  accountTag: string
  profileUrl: string
  fallbackTitle: string
}

export interface FeedSourceListConfig {
  polymarketSubscriptionEnabled?: boolean
  kalshiSubscriptionEnabled?: boolean
  feedCustomAccounts?: string[]
}

export const BUILT_IN_FEED_SOURCES = ["polymarket", "kalshi"] as const
export type BuiltInFeedSource = (typeof BUILT_IN_FEED_SOURCES)[number]
export const DEFAULT_PRIMARY_FEED_SOURCE: BuiltInFeedSource = "polymarket"
const CUSTOM_FEED_SOURCE_PREFIX = "x:"
const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/

const BUILT_IN_FEED_SOURCE_CONFIG: Record<BuiltInFeedSource, FeedSourceConfig> = {
  polymarket: {
    source: "polymarket",
    label: "Polymarket",
    accountHandle: "Polymarket",
    accountTag: "@Polymarket",
    profileUrl: "https://x.com/Polymarket",
    fallbackTitle: "Polymarket 更新",
  },
  kalshi: {
    source: "kalshi",
    label: "Kalshi",
    accountHandle: "Kalshi",
    accountTag: "@Kalshi",
    profileUrl: "https://x.com/Kalshi",
    fallbackTitle: "Kalshi 更新",
  },
}

const BUILT_IN_ACCOUNT_HANDLES = new Set(
  Object.values(BUILT_IN_FEED_SOURCE_CONFIG).map((config) => config.accountHandle.toLowerCase())
)

function extractHandleFromUrl(value: string): string {
  const trimmed = value.trim()
  if (!/^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i.test(trimmed)) {
    return ""
  }
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    const host = url.hostname.toLowerCase()
    if (host !== "x.com" && host !== "www.x.com" && host !== "twitter.com" && host !== "www.twitter.com") {
      return ""
    }
    return url.pathname.split("/").filter(Boolean)[0] || ""
  } catch {
    return ""
  }
}

export function isBuiltInFeedSource(source: FeedSource): source is BuiltInFeedSource {
  return BUILT_IN_FEED_SOURCES.includes(source as BuiltInFeedSource)
}

export function normalizeFeedAccountHandle(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ""
  }
  const fromUrl = extractHandleFromUrl(trimmed)
  const candidate = (fromUrl || trimmed)
    .trim()
    .replace(/^@+/, "")
    .split("/")[0]
    ?.split("?")[0]
    ?.split("#")[0]
    ?.trim() || ""
  if (!X_HANDLE_PATTERN.test(candidate)) {
    return ""
  }
  return candidate.toLowerCase()
}

export function normalizeFeedCustomAccounts(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : []
  const accounts = new Set<string>()
  for (const item of values) {
    const normalized = normalizeFeedAccountHandle(typeof item === "string" ? item : "")
    if (!normalized || BUILT_IN_ACCOUNT_HANDLES.has(normalized)) {
      continue
    }
    accounts.add(normalized)
  }
  return Array.from(accounts)
}

export function createCustomFeedSource(handle: string): FeedSource {
  const normalizedHandle = normalizeFeedAccountHandle(handle)
  return normalizedHandle ? `${CUSTOM_FEED_SOURCE_PREFIX}${normalizedHandle}` : ""
}

export function getCustomFeedSourceHandle(source: FeedSource): string {
  if (!source.startsWith(CUSTOM_FEED_SOURCE_PREFIX)) {
    return ""
  }
  return normalizeFeedAccountHandle(source.slice(CUSTOM_FEED_SOURCE_PREFIX.length))
}

export function isCustomFeedSource(source: FeedSource): boolean {
  return getCustomFeedSourceHandle(source).length > 0
}

export function isFeedSourceEnabledInConfig(source: FeedSource, config: FeedSourceListConfig): boolean {
  if (source === "polymarket") {
    return config.polymarketSubscriptionEnabled === true
  }
  if (source === "kalshi") {
    return config.kalshiSubscriptionEnabled === true
  }
  return resolveConfiguredFeedSources(config).includes(source)
}

export function resolveConfiguredFeedSources(config: FeedSourceListConfig): FeedSource[] {
  const customSources = normalizeFeedCustomAccounts(config.feedCustomAccounts)
    .map((handle) => createCustomFeedSource(handle))
    .filter((source): source is FeedSource => source.length > 0)
  return [...BUILT_IN_FEED_SOURCES, ...customSources]
}

export function getFeedSourceConfig(source: FeedSource): FeedSourceConfig {
  if (isBuiltInFeedSource(source)) {
    return BUILT_IN_FEED_SOURCE_CONFIG[source]
  }
  const normalizedHandle = getCustomFeedSourceHandle(source)
  const accountHandle =
    normalizedHandle || normalizeFeedAccountHandle(source) || source.replace(/^x:/i, "").trim().toLowerCase()
  return {
    source,
    label: `@${accountHandle}`,
    accountHandle,
    accountTag: `@${accountHandle}`,
    profileUrl: `https://x.com/${accountHandle}`,
    fallbackTitle: `@${accountHandle} 更新`,
  }
}
