"use client"

import { useEffect, useMemo, useRef } from "react"
import type { FeedItemRecord, FeedSubscriptionRecord } from "@/domain/feed/types"
import { openExternalUrl } from "@/lib/open-external-url"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ExternalLink, RefreshCcw } from "lucide-react"

export const POLYMARKET_FEED_AUTOLOAD_ROOT_MARGIN = "0px 0px 160px 0px"

export function shouldAutoLoadPolymarketPage(input: {
  subscriptionEnabled: boolean
  hasMore: boolean
  isLoading: boolean
}): boolean {
  return input.subscriptionEnabled && input.hasMore && !input.isLoading
}

function formatSyncTime(value: number | null): string {
  if (!value) {
    return "尚未同步"
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function formatItemTime(item: FeedItemRecord): string {
  const value = item.publishedAt || item.discoveredAt
  return formatSyncTime(value)
}

function getItemTitle(item: FeedItemRecord): string {
  return item.titleZh.trim() || item.title
}

function getItemContent(item: FeedItemRecord): string {
  return item.contentMarkdownZh.trim() || item.contentMarkdown
}

interface PolymarketFeedPaneProps {
  subscription: FeedSubscriptionRecord | null
  items: FeedItemRecord[]
  isLoading: boolean
  isSyncing: boolean
  hasMore: boolean
  onRefresh: () => void
  onLoadMore: () => void
  onOpenSettings: () => void
}

export function PolymarketFeedPane({
  subscription,
  items,
  isLoading,
  isSyncing,
  hasMore,
  onRefresh,
  onLoadMore,
  onOpenSettings,
}: PolymarketFeedPaneProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const autoLoadSentinelRef = useRef<HTMLDivElement | null>(null)
  const autoLoadRequestedRef = useRef(false)
  const statusLabel = useMemo(() => {
    if (isSyncing) {
      return "同步中..."
    }
    if (subscription?.lastError) {
      return subscription.lastError
    }
    return `上次同步 ${formatSyncTime(subscription?.lastSuccessAt || null)}`
  }, [isSyncing, subscription?.lastError, subscription?.lastSuccessAt])

  useEffect(() => {
    if (!isLoading) {
      autoLoadRequestedRef.current = false
    }
  }, [isLoading])

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return
    }
    const root = scrollContainerRef.current
    const target = autoLoadSentinelRef.current
    if (!root || !target) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        if (!visible || autoLoadRequestedRef.current) {
          return
        }
        if (
          !shouldAutoLoadPolymarketPage({
            subscriptionEnabled: subscription?.enabled === true,
            hasMore,
            isLoading,
          })
        ) {
          return
        }
        autoLoadRequestedRef.current = true
        onLoadMore()
      },
      {
        root,
        rootMargin: POLYMARKET_FEED_AUTOLOAD_ROOT_MARGIN,
        threshold: 0.01,
      }
    )
    observer.observe(target)
    return () => {
      observer.disconnect()
    }
  }, [hasMore, isLoading, onLoadMore, subscription?.enabled])

  return (
    <div className="mx-auto flex h-full w-full max-w-[72rem] flex-col px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Polymarket</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            同步 X 上的最新动态。应用运行期间每 10 分钟拉取一次。
          </p>
          <p
            className={cn(
              "mt-2 text-xs",
              subscription?.lastError ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {statusLabel}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onOpenSettings}>
            订阅设置
          </Button>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={isSyncing}>
            <RefreshCcw className={cn("mr-1 size-3.5", isSyncing ? "animate-spin" : "")} />
            {isSyncing ? "同步中..." : "立即同步"}
          </Button>
        </div>
      </div>

      {!subscription?.enabled ? (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-secondary/20 p-6">
          <p className="text-sm font-medium text-foreground">订阅尚未开启</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            开启后会在应用运行期间自动拉取 Polymarket 的最新动态，并保存在本地，支持后续“加载更多”。
          </p>
          <Button size="sm" className="mt-4" onClick={onOpenSettings}>
            去开启订阅
          </Button>
        </div>
      ) : null}

      <div ref={scrollContainerRef} className="mt-6 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card px-6 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {isLoading || isSyncing ? "正在拉取最新内容..." : "暂时还没有同步到内容"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              首次同步可能需要几秒。你也可以点击右上角“立即同步”。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((item) => (
              <article key={item.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="line-clamp-2 text-sm font-semibold leading-6 text-foreground">{getItemTitle(item)}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{formatItemTime(item)}</p>
                  </div>
                  {item.canonicalUrl ? (
                    <button
                      type="button"
                      onClick={() => {
                        void openExternalUrl(item.canonicalUrl)
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <ExternalLink className="size-3" />
                      原帖
                    </button>
                  ) : null}
                </div>

                {getItemContent(item) ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground">
                    {getItemContent(item)}
                  </p>
                ) : null}

                {item.mediaUrls.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.mediaUrls.map((mediaUrl) => (
                      <button
                        key={mediaUrl}
                        type="button"
                        onClick={() => {
                          void openExternalUrl(mediaUrl)
                        }}
                        className="relative h-[88px] w-[88px] overflow-hidden rounded-xl border border-border/70 bg-secondary/30"
                      >
                        <img src={mediaUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            <div ref={autoLoadSentinelRef} aria-hidden="true" className="h-1 w-full" />
          </div>
        )}
      </div>

      {items.length > 0 ? (
        <div className="mt-4 flex justify-center">
          <Button size="sm" variant="outline" onClick={onLoadMore} disabled={isLoading || !hasMore}>
            {isLoading ? "加载中..." : hasMore ? "加载更多" : "没有更多了"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
