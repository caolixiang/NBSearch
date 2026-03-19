import type { AppConfig } from "@/app/contracts"
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
import type { JinaReaderClient } from "./jina-reader-client"
import { RuntimeJinaReaderClient } from "./jina-reader-client"
import {
  OpenAIFeedTranslator,
  type FeedTranslator,
} from "./openai-feed-translator"
import { parsePolymarketTimeline } from "./polymarket-timeline-parser"

const POLYMARKET_SOURCE: FeedSource = "polymarket"
const POLL_INTERVAL_MINUTES = 10
const STARTUP_SYNC_DELAY_MS = 10_000
const TRANSLATION_BACKFILL_LIMIT = 20
const SYNC_RETRY_MAX_ATTEMPTS = 3
const SYNC_RETRY_DELAY_MS = 1_500
const FAILED_POLL_RETRY_DELAY_MS = 60_000

type PolymarketFeedServiceOptions = {
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

export class PolymarketFeedService implements FeedService {
  private readonly listeners = new Set<(event: FeedServiceEvent) => void>()
  private readonly sourceState: FeedSourceState = {
    isSyncing: false,
    lastError: "",
    lastCompletedAt: null,
    inFlight: null,
  }
  private pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private startupTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private started = false

  constructor(
    private readonly repository: AppRepository,
    private readonly config: AppConfig,
    private readonly client: JinaReaderClient = new RuntimeJinaReaderClient(),
    private readonly translator: FeedTranslator = new OpenAIFeedTranslator(config),
    private readonly options: PolymarketFeedServiceOptions = {}
  ) {}

  ensureStarted(): void {
    if (this.started) {
      return
    }
    this.started = true
    void this.ensureSubscription()
    this.reconfigureTimers()
  }

  async getSubscription(source: FeedSource): Promise<FeedSubscriptionRecord> {
    const existing = await this.repository.getFeedSubscription(source)
    if (existing) {
      return existing
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
    const current = await this.getSubscription(input.source)
    const next: FeedSubscriptionRecord = {
      ...current,
      enabled: input.enabled,
      updatedAt: Date.now(),
    }
    await this.repository.upsertFeedSubscription(next)
    this.applyConfig({
      polymarketEnabled: next.enabled,
    })
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
    if (source !== POLYMARKET_SOURCE) {
      return Promise.reject(new Error(`Unsupported feed source: ${source}`))
    }
    if (this.sourceState.inFlight) {
      return this.sourceState.inFlight
    }
    const promise = this.runPolymarketSync()
    this.sourceState.inFlight = promise
    void promise
      .finally(() => {
        if (this.sourceState.inFlight === promise) {
          this.sourceState.inFlight = null
        }
      })
      .catch(() => {})
    return promise
  }

  getRuntimeState(source: FeedSource): FeedRuntimeState {
    return {
      source,
      isSyncing: this.sourceState.isSyncing,
      lastError: this.sourceState.lastError,
      lastCompletedAt: this.sourceState.lastCompletedAt,
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
  }): void {
    this.config.polymarketSubscriptionEnabled = input.polymarketEnabled
    this.reconfigureTimers()
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
    if (source === POLYMARKET_SOURCE) {
      return this.config.polymarketSubscriptionEnabled === true
    }
    return false
  }

  private async ensureSubscription(): Promise<FeedSubscriptionRecord> {
    return this.getSubscription(POLYMARKET_SOURCE)
  }

  private clearTimers(): void {
    if (this.startupTimer) {
      globalThis.clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.pollTimer) {
      globalThis.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private reconfigureTimers(): void {
    this.clearTimers()
    if (!this.resolveEnabled(POLYMARKET_SOURCE)) {
      return
    }
    this.startupTimer = globalThis.setTimeout(() => {
      void this.syncNow(POLYMARKET_SOURCE)
        .then(() => {
          this.scheduleNextPoll()
        })
        .catch(() => {
          this.scheduleNextPoll(this.resolveFailedPollRetryDelayMs())
        })
    }, STARTUP_SYNC_DELAY_MS)
  }

  private scheduleNextPoll(delayMs = POLL_INTERVAL_MINUTES * 60 * 1000): void {
    if (!this.resolveEnabled(POLYMARKET_SOURCE)) {
      return
    }
    if (this.pollTimer) {
      globalThis.clearTimeout(this.pollTimer)
    }
    this.pollTimer = globalThis.setTimeout(() => {
      void this.syncNow(POLYMARKET_SOURCE)
        .then(() => {
          this.scheduleNextPoll()
        })
        .catch(() => {
          this.scheduleNextPoll(this.resolveFailedPollRetryDelayMs())
        })
    }, delayMs)
  }

  private async backfillPendingTranslations(excludeContentHashes: string[]): Promise<void> {
    const pendingItems = await this.repository.listFeedItemsNeedingTranslation({
      source: POLYMARKET_SOURCE,
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

  private async runPolymarketSync(): Promise<FeedSyncResult> {
    const subscription = await this.ensureSubscription()
    this.sourceState.isSyncing = true
    this.emit({ type: "sync_started", source: POLYMARKET_SOURCE })

    try {
      const result = await this.runPolymarketSyncWithRetry(subscription)
      this.sourceState.isSyncing = false
      this.sourceState.lastError = ""
      this.sourceState.lastCompletedAt = result.fetchedAt
      this.emit({ type: "subscription_updated", source: POLYMARKET_SOURCE })
      this.emit({ type: "sync_completed", source: POLYMARKET_SOURCE, result })
      return result
    } catch (error) {
      const failedAt = Date.now()
      const message = error instanceof Error ? error.message : "Polymarket 同步失败"
      await this.repository.upsertFeedSubscription({
        ...subscription,
        enabled: this.resolveEnabled(POLYMARKET_SOURCE),
        lastPolledAt: failedAt,
        lastError: message,
        updatedAt: failedAt,
      })
      this.sourceState.isSyncing = false
      this.sourceState.lastError = message
      this.emit({ type: "subscription_updated", source: POLYMARKET_SOURCE })
      this.emit({ type: "sync_failed", source: POLYMARKET_SOURCE, error: message })
      throw error
    }
  }

  private async runPolymarketSyncWithRetry(
    subscription: FeedSubscriptionRecord
  ): Promise<FeedSyncResult> {
    const maxAttempts = this.resolveSyncRetryMaxAttempts()
    let lastError: unknown = new Error("Polymarket 同步失败")

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runPolymarketSyncAttempt(subscription)
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

  private async runPolymarketSyncAttempt(
    subscription: FeedSubscriptionRecord
  ): Promise<FeedSyncResult> {
    const fetchedAt = Date.now()
    const raw = await this.client.fetchPolymarketTimeline()
    const parsed = parsePolymarketTimeline(raw)
    const items = await Promise.all(
      parsed.map(async (item, index) => {
        const normalizedTitle = item.title.trim() || "Polymarket 更新"
        const normalizedMarkdown = item.contentMarkdown.trim()
        const normalizedMediaUrls = Array.from(new Set(item.mediaUrls))
        const contentHash = await sha256Hex(
          [
            normalizedTitle,
            normalizedMarkdown,
            normalizedMediaUrls.join("|"),
            item.canonicalUrl.trim(),
          ].join("\n")
        )
        return {
          id: `feed_item_${contentHash.slice(0, 24)}`,
          subscriptionId: subscription.id,
          source: POLYMARKET_SOURCE,
          contentHash,
          title: normalizedTitle,
          contentMarkdown: normalizedMarkdown,
          titleZh: "",
          contentMarkdownZh: "",
          translationStatus: "skipped" as const,
          translationModel: "",
          translatedAt: null,
          mediaUrls: normalizedMediaUrls,
          canonicalUrl: item.canonicalUrl.trim(),
          publishedAt: item.publishedAt,
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
    await this.backfillPendingTranslations(pendingItems.map((item) => item.contentHash))
    const nextSubscription: FeedSubscriptionRecord = {
      ...subscription,
      enabled: this.resolveEnabled(POLYMARKET_SOURCE),
      lastPolledAt: fetchedAt,
      lastSuccessAt: fetchedAt,
      lastError: "",
      updatedAt: fetchedAt,
    }
    await this.repository.upsertFeedSubscription(nextSubscription)
    return {
      source: POLYMARKET_SOURCE,
      fetchedAt,
      insertedCount,
      parsedCount: parsed.length,
    }
  }
}
