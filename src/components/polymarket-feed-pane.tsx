"use client"

import { useEffect, useMemo, useRef } from "react"
import { getFeedSourceConfig } from "@/domain/feed/source-config"
import type { FeedItemRecord, FeedSource, FeedSubscriptionRecord } from "@/domain/feed/types"
import { openExternalUrl } from "@/lib/open-external-url"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { RefreshCcw } from "lucide-react"

export const FEED_AUTOLOAD_ROOT_MARGIN = "0px 0px 160px 0px"

export function shouldAutoLoadFeedPage(input: {
  subscriptionEnabled: boolean
  hasMore: boolean
  isLoading: boolean
}): boolean {
  return input.subscriptionEnabled && input.hasMore && !input.isLoading
}

export function normalizeFeedCardText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
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

export function getFeedItemTitle(item: FeedItemRecord): string {
  return normalizeFeedCardText(item.titleZh.trim() || item.title)
}

export function getFeedItemContent(item: FeedItemRecord): string {
  const content = normalizeFeedCardText(item.contentMarkdownZh.trim() || item.contentMarkdown)
  const title = getFeedItemTitle(item)
  if (!content) {
    return ""
  }
  if (content === title) {
    return ""
  }
  return content
}

interface FeedPaneProps {
  source: FeedSource
  subscription: FeedSubscriptionRecord | null
  items: FeedItemRecord[]
  isLoading: boolean
  isSyncing: boolean
  hasMore: boolean
  researchingItemId?: string | null
  onRefresh: () => void
  onLoadMore: () => void
  onOpenSettings: () => void
  onDeepResearch: (item: FeedItemRecord) => void
}

export function FeedPane({
  source,
  subscription,
  items,
  isLoading,
  isSyncing,
  hasMore,
  researchingItemId,
  onRefresh,
  onLoadMore,
  onOpenSettings,
  onDeepResearch,
}: FeedPaneProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const autoLoadSentinelRef = useRef<HTMLDivElement | null>(null)
  const autoLoadRequestedRef = useRef(false)
  const sourceConfig = getFeedSourceConfig(source)
  const statusLabel = useMemo(() => {
    if (isSyncing) {
      return "同步中..."
    }
    if (subscription?.lastError) {
      return subscription.lastError
    }
    return `上次同步 ${formatSyncTime(subscription?.lastSuccessAt || null)}`
  }, [isSyncing, subscription?.lastError, subscription?.lastSuccessAt])
  const refreshLabel = isSyncing ? "同步中..." : subscription?.lastError ? "重试同步" : "立即同步"

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
          !shouldAutoLoadFeedPage({
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
        rootMargin: FEED_AUTOLOAD_ROOT_MARGIN,
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
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{sourceConfig.label}</h2>
            <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              @{sourceConfig.accountHandle}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            同步 X 上的最新动态。应用运行期间每 30 分钟自动同步一次。
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
            {refreshLabel}
          </Button>
        </div>
      </div>

      {!subscription?.enabled ? (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-secondary/20 p-6">
          <p className="text-sm font-medium text-foreground">订阅尚未开启</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            开启后会在应用运行期间自动拉取 {sourceConfig.label} 的最新动态，并保存在本地，支持后续“加载更多”。
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
                    <h3 className="line-clamp-2 text-sm font-semibold leading-6 text-foreground">{getFeedItemTitle(item)}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{formatItemTime(item)}</p>
                  </div>
                </div>

                {getFeedItemContent(item) ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground">
                    {getFeedItemContent(item)}
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

                <div
                  className={cn(
                    "flex items-center justify-end",
                    item.mediaUrls.length > 0 || getFeedItemContent(item) ? "mt-3" : "mt-2"
                  )}
                >
                  <Button
                    size="sm"
                    className="rounded-full px-3.5"
                    onClick={() => {
                      onDeepResearch(item)
                    }}
                    disabled={Boolean(researchingItemId)}
                  >
                    {researchingItemId === item.id ? "发送中..." : "继续深入调研"}
                  </Button>
                </div>
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
