import type {
  FeedItemRecord,
  FeedPage,
  FeedPageCursor,
  FeedSource,
  FeedSubscriptionRecord,
  FeedSyncResult,
} from "./types"

export type FeedServiceEvent =
  | { type: "subscription_updated"; source: FeedSource }
  | { type: "sync_started"; source: FeedSource }
  | { type: "sync_completed"; source: FeedSource; result: FeedSyncResult }
  | { type: "sync_failed"; source: FeedSource; error: string }

export interface FeedRuntimeState {
  source: FeedSource
  isSyncing: boolean
  lastError: string
  lastCompletedAt: number | null
}

export interface FeedService {
  ensureStarted(): void

  getSubscription(source: FeedSource): Promise<FeedSubscriptionRecord>

  updateSubscription(input: {
    source: FeedSource
    enabled: boolean
  }): Promise<FeedSubscriptionRecord>

  listItems(input: {
    source: FeedSource
    limit: number
    cursor?: FeedPageCursor | null
  }): Promise<FeedPage<FeedItemRecord>>

  syncNow(source: FeedSource): Promise<FeedSyncResult>

  getRuntimeState(source: FeedSource): FeedRuntimeState

  subscribe(listener: (event: FeedServiceEvent) => void): () => void

  applyConfig(input: {
    polymarketEnabled: boolean
    kalshiEnabled: boolean
    customAccounts: string[]
  }): void
}
