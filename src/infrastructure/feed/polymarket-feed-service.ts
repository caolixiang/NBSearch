import type { AppConfig } from "@/app/contracts"
import { hasTauriRuntime } from "@/app/runtime-info"
import {
  getFeedSourceConfig,
  isFeedSourceEnabledInConfig,
  normalizeFeedCustomAccounts,
  resolveConfiguredFeedSources,
} from "@/domain/feed/source-config"
import type {
  FeedRuntimeState,
  FeedService,
  FeedServiceEvent,
} from "@/domain/feed/service"
import type {
  FeedItemRecord,
  FeedPage,
  FeedPageCursor,
  FeedSource,
  FeedSubscriptionRecord,
  FeedSyncResult,
} from "@/domain/feed/types"
import type { AppRepository } from "@/domain/storage/repository"
import { listenToNativeFeedSyncTick } from "./native-feed-sync"
import type { FeedFetchClient } from "./grok-feed-client"
import { RuntimeGrokFeedClient } from "./grok-feed-client"
import {
  OpenAIFeedTranslator,
  type FeedTranslator,
} from "./openai-feed-translator"

const POLL_INTERVAL_MINUTES = 30
const FEED_RETENTION_MS = 48 * 60 * 60 * 1000
const FEED_CLEANUP_INTERVAL_MS = 30 * 60 * 1000
const STARTUP_SYNC_DELAY_MS = 10_000
const SCHEDULER_TICK_INTERVAL_MS = 60_000
const TRANSLATION_BACKFILL_LIMIT = 20
const SYNC_RETRY_MAX_ATTEMPTS = 3
const SYNC_RETRY_DELAY_MS = 1_500
const FAILED_POLL_RETRY_DELAY_MS = 60_000

type FeedSyncServiceOptions = {
  syncRetryMaxAttempts?: number
  syncRetryDelayMs?: number
  failedPollRetryDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

type FeedSourceState = {
  isSyncing: boolean
  lastError: string
  lastCompletedAt: number | null
  inFlight: Promise<FeedSyncResult> | null
}

function createDefaultSubscription(
  source: FeedSource,
  enabled: boolean,
  now = Date.now()
): FeedSubscriptionRecord {
  return {
    id: `feed_sub_${source}`,
    source,
    enabled,
    pollIntervalMinutes: POLL_INTERVAL_MINUTES,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastError: "",
    createdAt: now,
    updatedAt: now,
  }
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

async function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return
  }
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs)
  })
}

function createDefaultSourceState(): FeedSourceState {
  return {
    isSyncing: false,
    lastError: "",
    lastCompletedAt: null,
    inFlight: null,
  }
}

function createSourceStateMap(): Record<FeedSource, FeedSourceState> {
  return {}
}

export class FeedSyncService implements FeedService {
  private readonly listeners = new Set<(event: FeedServiceEvent) => void>()
  private readonly sourceStateBySource: Record<FeedSource, FeedSourceState> = createSourceStateMap()
  private startupTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private localTickTimer: ReturnType<typeof globalThis.setInterval> | null = null
  private nativeTickUnlisten: (() => void) | null = null
  private nativeTickReady = false
  private started = false
  private lastFeedCleanupAt = 0

  constructor(
    private readonly repository: AppRepository,
    private readonly config: AppConfig,
    private readonly client: FeedFetchClient = new RuntimeGrokFeedClient(config),
    private readonly translator: FeedTranslator = new OpenAIFeedTranslator(config),
    private readonly options: FeedSyncServiceOptions = {}
  ) {}

  ensureStarted(): void {
    if (this.started) {
      return
    }
    this.started = true
    for (const source of this.getConfiguredSources()) {
      this.getOrCreateSourceState(source)
    }
    void Promise.all(this.getConfiguredSources().map((source) => this.getSubscription(source))).catch(() => {})
    void this.maybeCleanupExpiredFeedItems(true).catch(() => {})
    this.initializeScheduling()
  }

  async getSubscription(source: FeedSource): Promise<FeedSubscriptionRecord> {
    const desiredEnabled = this.resolveEnabled(source)
    const existing = await this.repository.getFeedSubscription(source)
    if (existing) {
      if (existing.pollIntervalMinutes === POLL_INTERVAL_MINUTES && existing.enabled === desiredEnabled) {
        return existing
      }
      const normalized: FeedSubscriptionRecord = {
        ...existing,
        enabled: desiredEnabled,
        pollIntervalMinutes: POLL_INTERVAL_MINUTES,
        updatedAt: Date.now(),
      }
      await this.repository.upsertFeedSubscription(normalized)
      this.emit({ type: "subscription_updated", source })
      return normalized
    }
    const created = createDefaultSubscription(source, this.resolveEnabled(source))
    await this.repository.upsertFeedSubscription(created)
    this.emit({ type: "subscription_updated", source })
    return created
  }

  async updateSubscription(input: {
    source: FeedSource
    enabled: boolean
  }): Promise<FeedSubscriptionRecord> {
    this.getOrCreateSourceState(input.source)
    const current = await this.getSubscription(input.source)
    const next: FeedSubscriptionRecord = {
      ...current,
      enabled: input.enabled,
      updatedAt: Date.now(),
    }
    await this.repository.upsertFeedSubscription(next)
    this.emit({
      type: "subscription_updated",
      source: input.source,
    })
    return next
  }

  async listItems(input: {
    source: FeedSource
    limit: number
    cursor?: FeedPageCursor | null
  }): Promise<FeedPage<FeedItemRecord>> {
    return this.repository.listFeedItems(input)
  }

  syncNow(source: FeedSource): Promise<FeedSyncResult> {
    const state = this.getOrCreateSourceState(source)
    if (state.inFlight) {
      return state.inFlight
    }
    const promise = this.runSync(source)
    state.inFlight = promise
    void promise
      .finally(() => {
        if (state.inFlight === promise) {
          state.inFlight = null
        }
      })
      .catch(() => {})
    return promise
  }

  getRuntimeState(source: FeedSource): FeedRuntimeState {
    const state = this.getOrCreateSourceState(source)
    return {
      source,
      isSyncing: state.isSyncing,
      lastError: state.lastError,
      lastCompletedAt: state.lastCompletedAt,
    }
  }

  subscribe(listener: (event: FeedServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  applyConfig(input: {
    polymarketEnabled: boolean
    kalshiEnabled: boolean
    customAccounts: string[]
  }): void {
    this.config.polymarketSubscriptionEnabled = input.polymarketEnabled
    this.config.kalshiSubscriptionEnabled = input.kalshiEnabled
    this.config.feedCustomAccounts = normalizeFeedCustomAccounts(input.customAccounts)
    for (const source of this.getConfiguredSources()) {
      this.getOrCreateSourceState(source)
    }
  }

  private emit(event: FeedServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Ignore listener failures to keep the poller alive.
      }
    }
  }

  private resolveEnabled(source: FeedSource): boolean {
    return isFeedSourceEnabledInConfig(source, this.config)
  }

  private getConfiguredSources(): FeedSource[] {
    return resolveConfiguredFeedSources(this.config)
  }

  private getOrCreateSourceState(source: FeedSource): FeedSourceState {
    const existing = this.sourceStateBySource[source]
    if (existing) {
      return existing
    }
    const created = createDefaultSourceState()
    this.sourceStateBySource[source] = created
    return created
  }

  private initializeScheduling(): void {
    this.clearScheduling()
    this.startupTimer = globalThis.setTimeout(() => {
      void this.syncDueSources()
    }, STARTUP_SYNC_DELAY_MS)
    void this.ensureNativeTicker()
  }

  private clearScheduling(): void {
    if (this.startupTimer) {
      globalThis.clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.localTickTimer) {
      globalThis.clearInterval(this.localTickTimer)
      this.localTickTimer = null
    }
  }

  private async ensureNativeTicker(): Promise<void> {
    if (this.nativeTickReady) {
      return
    }
    if (!hasTauriRuntime()) {
      if (!this.localTickTimer) {
        this.localTickTimer = globalThis.setInterval(() => {
          void this.syncDueSources()
        }, SCHEDULER_TICK_INTERVAL_MS)
      }
      return
    }
    try {
      this.nativeTickUnlisten = await listenToNativeFeedSyncTick(() => {
        void this.syncDueSources()
      })
      this.nativeTickReady = true
    } catch {
      this.nativeTickReady = false
      if (!this.localTickTimer) {
        this.localTickTimer = globalThis.setInterval(() => {
          void this.syncDueSources()
        }, SCHEDULER_TICK_INTERVAL_MS)
      }
    }
  }

  private async syncDueSources(): Promise<void> {
    await Promise.allSettled([
      this.maybeCleanupExpiredFeedItems(),
      ...this.getConfiguredSources().map((source) => this.syncDueSource(source)),
    ])
  }

  private async maybeCleanupExpiredFeedItems(force = false): Promise<void> {
    const now = Date.now()
    if (!force && this.lastFeedCleanupAt > 0 && now - this.lastFeedCleanupAt < FEED_CLEANUP_INTERVAL_MS) {
      return
    }
    await this.repository.deleteFeedItemsOlderThan(now - FEED_RETENTION_MS)
    this.lastFeedCleanupAt = now
  }

  private async syncDueSource(source: FeedSource): Promise<void> {
    const subscription = await this.getSubscription(source)
    if (!subscription.enabled || !this.resolveEnabled(source)) {
      return
    }
    const lastPolledAt = subscription.lastPolledAt || 0
    const retryDelayMs = subscription.lastError
      ? this.resolveFailedPollRetryDelayMs()
      : subscription.pollIntervalMinutes * 60 * 1000
    if (lastPolledAt > 0 && Date.now() - lastPolledAt < retryDelayMs) {
      return
    }
    await this.syncNow(source)
  }

  private async backfillPendingTranslations(source: FeedSource, excludeContentHashes: string[]): Promise<void> {
    const pendingItems = await this.repository.listFeedItemsNeedingTranslation({
      source,
      limit: TRANSLATION_BACKFILL_LIMIT,
      excludeContentHashes,
    })
    if (pendingItems.length === 0) {
      return
    }
    const translations = await this.translator.translateMany(
      pendingItems.map((item) => ({
        contentHash: item.contentHash,
        title: item.title,
        contentMarkdown: item.contentMarkdown,
      }))
    )
    const translationByHash = new Map(translations.map((item) => [item.contentHash, item]))
    const updates = pendingItems
      .map((item) => {
        const translated = translationByHash.get(item.contentHash)
        if (!translated) {
          return null
        }
        return {
          id: item.id,
          titleZh: translated.titleZh,
          contentMarkdownZh: translated.contentMarkdownZh,
          translationStatus: translated.status,
          translationModel: translated.model,
          translatedAt: translated.translatedAt,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    await this.repository.updateFeedItemTranslations(updates)
  }

  private resolveSyncRetryMaxAttempts(): number {
    return Math.max(1, this.options.syncRetryMaxAttempts ?? SYNC_RETRY_MAX_ATTEMPTS)
  }

  private resolveSyncRetryDelayMs(): number {
    return Math.max(0, this.options.syncRetryDelayMs ?? SYNC_RETRY_DELAY_MS)
  }

  private resolveFailedPollRetryDelayMs(): number {
    return Math.max(0, this.options.failedPollRetryDelayMs ?? FAILED_POLL_RETRY_DELAY_MS)
  }

  private async waitForRetry(): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep
    await sleep(this.resolveSyncRetryDelayMs())
  }

  private async runSync(source: FeedSource): Promise<FeedSyncResult> {
    await this.maybeCleanupExpiredFeedItems()
    const subscription = await this.getSubscription(source)
    const state = this.getOrCreateSourceState(source)
    state.isSyncing = true
    this.emit({ type: "sync_started", source })

    try {
      const result = await this.runSyncWithRetry(source, subscription)
      state.isSyncing = false
      state.lastError = ""
      state.lastCompletedAt = result.fetchedAt
      this.emit({ type: "subscription_updated", source })
      this.emit({ type: "sync_completed", source, result })
      return result
    } catch (error) {
      const failedAt = Date.now()
      const message =
        error instanceof Error ? error.message : `${getFeedSourceConfig(source).label} 同步失败`
      await this.repository.upsertFeedSubscription({
        ...subscription,
        enabled: this.resolveEnabled(source),
        lastPolledAt: failedAt,
        lastError: message,
        updatedAt: failedAt,
      })
      state.isSyncing = false
      state.lastError = message
      this.emit({ type: "subscription_updated", source })
      this.emit({ type: "sync_failed", source, error: message })
      throw error
    }
  }

  private async runSyncWithRetry(
    source: FeedSource,
    subscription: FeedSubscriptionRecord
  ): Promise<FeedSyncResult> {
    const maxAttempts = this.resolveSyncRetryMaxAttempts()
    let lastError: unknown = new Error(`${getFeedSourceConfig(source).label} 同步失败`)

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runSyncAttempt(source, subscription)
      } catch (error) {
        lastError = error
        if (attempt >= maxAttempts) {
          break
        }
        await this.waitForRetry()
      }
    }

    throw lastError
  }

  private async runSyncAttempt(
    source: FeedSource,
    subscription: FeedSubscriptionRecord
  ): Promise<FeedSyncResult> {
    const fetchedAt = Date.now()
    const posts = await this.client.fetchPosts(source)
    const items = await Promise.all(
      posts.map(async (post, index) => {
        const normalizedMarkdown = post.content.trim()
        const firstLine = normalizedMarkdown
          .split(/\r?\n/)
          .find((line) => line.trim().length > 0)
          ?.trim()
        const normalizedTitle = firstLine
          ? firstLine.length > 96
            ? `${firstLine.slice(0, 93)}...`
            : firstLine
          : getFeedSourceConfig(source).fallbackTitle
        const normalizedMediaUrls = Array.from(new Set(post.mediaUrls))
        const contentHash = await sha256Hex(`${source}:${post.postId}`)
        return {
          id: `feed_item_${source}_${post.postId}`,
          subscriptionId: subscription.id,
          source,
          contentHash,
          title: normalizedTitle,
          contentMarkdown: normalizedMarkdown,
          titleZh: "",
          contentMarkdownZh: "",
          translationStatus: "skipped" as const,
          translationModel: "",
          translatedAt: null,
          mediaUrls: normalizedMediaUrls,
          canonicalUrl: post.canonicalUrl.trim(),
          publishedAt: post.publishedAt,
          discoveredAt: fetchedAt - index,
          fetchedAt,
        } satisfies FeedItemRecord
      })
    )
    const existingContentHashes = new Set(
      await this.repository.listExistingFeedItemContentHashes({
        subscriptionId: subscription.id,
        contentHashes: items.map((item) => item.contentHash),
      })
    )
    const pendingItems = items.filter((item) => !existingContentHashes.has(item.contentHash))
    const translations =
      pendingItems.length > 0
        ? await this.translator.translateMany(
            pendingItems.map((item) => ({
              contentHash: item.contentHash,
              title: item.title,
              contentMarkdown: item.contentMarkdown,
            }))
          )
        : []
    const translationByHash = new Map(translations.map((item) => [item.contentHash, item]))
    const translatedItems = pendingItems.map((item) => {
      const translated = translationByHash.get(item.contentHash)
      if (!translated) {
        return item
      }
      return {
        ...item,
        titleZh: translated.titleZh,
        contentMarkdownZh: translated.contentMarkdownZh,
        translationStatus: translated.status,
        translationModel: translated.model,
        translatedAt: translated.translatedAt,
      } satisfies FeedItemRecord
    })
    const insertedCount = await this.repository.insertFeedItems(translatedItems)
    await this.backfillPendingTranslations(source, pendingItems.map((item) => item.contentHash))
    const nextSubscription: FeedSubscriptionRecord = {
      ...subscription,
      enabled: this.resolveEnabled(source),
      lastPolledAt: fetchedAt,
      lastSuccessAt: fetchedAt,
      lastError: "",
      updatedAt: fetchedAt,
    }
    await this.repository.upsertFeedSubscription(nextSubscription)
    return {
      source,
      fetchedAt,
      insertedCount,
      parsedCount: posts.length,
    }
  }
}

export { FeedSyncService as PolymarketFeedService }
