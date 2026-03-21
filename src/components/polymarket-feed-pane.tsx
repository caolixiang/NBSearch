"use client"

import { useEffect, useMemo, useRef } from "react"
import { FEED_SOURCES, getFeedSourceConfig } from "@/domain/feed/source-config"
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

function XTwitterIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M21.742 21.75l-7.563-11.179 7.056-8.321h-2.456l-5.691 6.714-4.54-6.714H2.359l7.29 10.776L2.25 21.75h2.456l6.035-7.118 4.818 7.118h6.191-.008zM7.739 3.818L18.81 20.182h-2.447L5.29 3.818h2.447z" />
    </svg>
  )
}

function PolymarketWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 911 168" aria-hidden="true" className={className} fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M395.676 132.183V29.2346H378.683V132.183H395.676ZM228.862 96.1278V132.186H211.188V34.6007H249.334C256.841 34.6007 263.335 35.93 268.817 38.5885C274.299 41.247 278.474 44.9332 281.34 49.6475C284.206 54.3613 285.639 59.7346 285.639 65.7666C285.639 72.0667 284.217 77.4955 281.374 82.053C278.53 86.6104 274.391 90.0957 268.954 92.5088C263.517 94.9218 256.978 96.1278 249.334 96.1278H228.862ZM228.861 82.1873H249.334C255.658 82.1873 260.332 80.7347 263.358 77.8307C266.383 74.9261 267.896 70.9493 267.896 65.9003C267.896 62.7729 267.236 59.9019 265.917 57.2879C264.598 54.674 262.55 52.5741 259.775 50.9878C257 49.4015 253.52 48.6083 249.334 48.6083H228.861V82.1873ZM329.499 133.53C336.551 133.53 342.67 131.944 347.856 128.772C353.043 125.599 357.013 121.22 359.765 115.635C362.517 110.05 363.893 103.727 363.893 96.6673V95.2599C363.893 88.2002 362.517 81.8775 359.765 76.2924C357.013 70.7073 353.032 66.3172 347.823 63.122C342.613 59.9273 336.46 58.33 329.363 58.33C322.357 58.33 316.26 59.9273 311.074 63.122C305.888 66.3172 301.919 70.7073 299.166 76.2924C296.414 81.8775 295.037 88.2002 295.037 95.2599V96.6673C295.037 103.727 296.414 110.05 299.166 115.635C301.919 121.22 305.899 125.599 311.108 128.772C316.317 131.944 322.448 133.53 329.499 133.53ZM316.397 113.559C319.309 117.938 323.676 120.127 329.5 120.127C333.366 120.127 336.608 119.088 339.224 117.01C341.84 114.933 343.774 112.129 345.025 108.599C346.276 105.069 346.901 101.093 346.901 96.6691V95.2617C346.901 90.8825 346.276 86.9173 345.025 83.3649C343.774 79.8125 341.829 76.9866 339.19 74.8862C336.551 72.7863 333.276 71.7361 329.363 71.7361C325.496 71.7361 322.266 72.7863 319.673 74.8862C317.08 76.9866 315.157 79.8125 313.906 83.3649C312.655 86.9173 312.029 90.8825 312.029 95.2617V96.6691C312.029 103.55 313.486 109.18 316.397 113.559ZM435.067 156.07C431.586 159.667 426.616 161.465 420.155 161.465C417.926 161.465 415.22 161.063 412.035 160.259V147.457L415.174 147.592C419.223 147.592 422.305 146.888 424.421 145.48C426.536 144.073 428.208 141.604 429.437 138.074L431.757 131.908L405.825 59.657H424.182L439.536 108.316L454.413 59.657H472.497L443.085 143.168C441.22 148.172 438.547 152.473 435.067 156.07ZM498.752 132.19V79.7777C501.482 74.5498 506.099 71.9359 512.605 71.9359C516.882 71.9359 520.121 72.9635 522.329 75.0188C524.537 77.074 525.641 80.5373 525.641 85.4074V132.19H542.632V83.8662L542.563 82.3245C543.562 79.1519 545.259 76.6277 547.647 74.7507C550.036 72.8743 553.005 71.9359 556.555 71.9359C560.874 71.9359 564.116 72.9079 566.278 74.8514C568.44 76.795 569.521 80.2467 569.521 85.2065V132.19H586.512V85.2737C586.512 75.9347 584.443 69.1094 580.3 64.798C576.162 60.486 570.177 58.33 562.356 58.33C557.392 58.33 553.005 59.3021 549.181 61.2456C545.364 63.1891 542.197 65.9038 539.698 69.3891C537.833 65.6358 535.171 62.8539 531.714 61.0447C528.256 59.2349 524.206 58.33 519.566 58.33C515.016 58.33 510.956 59.1006 507.385 60.6423C503.813 62.1841 500.777 64.4067 498.275 67.3112L497.728 59.6703H481.76V132.19H498.752ZM636.991 131.319C633.76 132.793 630.099 133.53 626.002 133.53C621.179 133.53 616.862 132.592 613.038 130.715C609.215 128.839 606.234 126.247 604.101 122.941C601.963 119.634 600.894 115.925 600.894 111.815C600.894 104.085 603.816 98.1645 609.662 94.0534C615.508 89.9429 623.8 87.8876 634.533 87.8876H644.771V83.1958C644.771 79.3533 643.702 76.348 641.564 74.181C639.425 72.014 636.264 70.9302 632.075 70.9302C629.576 70.9302 627.368 71.3552 625.456 72.2039C623.544 73.0527 622.068 74.2146 621.022 75.6892C619.976 77.1638 619.453 78.8167 619.453 80.649H602.462C602.462 76.7614 603.723 73.1088 606.245 69.6907C608.773 66.2726 612.364 63.5243 617.03 61.4465C621.691 59.3687 627.025 58.33 633.033 58.33C638.676 58.33 643.656 59.2685 647.979 61.1449C652.302 63.0218 655.678 65.8367 658.113 69.59C660.548 73.3433 661.762 77.9233 661.762 83.3295V115.3C661.762 121.913 662.698 127.163 664.563 131.05V132.19H647.229C646.497 130.626 645.864 128.369 645.318 125.421C642.993 127.878 640.222 129.844 636.991 131.319ZM629.28 120.189C625.689 120.189 622.888 119.261 620.889 117.408C618.884 115.553 617.885 113.151 617.885 110.202C617.885 106.404 619.407 103.455 622.458 101.355C625.503 99.2552 629.989 98.205 635.898 98.205H644.771V111.744C643.499 114.067 641.482 116.056 638.734 117.709C635.98 119.362 632.83 120.189 629.28 120.189ZM695.797 82.7934V132.19H678.806V59.6703H694.977L695.454 67.8473C697.319 64.809 699.644 62.4631 702.415 60.8097C705.193 59.1568 708.401 58.33 712.038 58.33C712.997 58.33 714.072 58.4192 715.281 58.5981C716.484 58.777 717.384 58.9779 717.977 59.2013L717.837 74.9516C715.565 74.5944 713.311 74.4155 711.085 74.4155C703.485 74.4155 698.388 77.2083 695.797 82.7934ZM745.183 132.183V108.657L752.627 101.218L774.122 132.183H793.774L763.546 89.8242L790.909 59.6633H770.438L750.239 82.1161L745.183 88.2824V29.2346H728.262V132.183H745.183ZM851.354 129.643C846.577 132.234 840.796 133.53 834.02 133.53C826.832 133.53 820.55 132 815.181 128.939C809.818 125.879 805.698 121.689 802.833 116.372C799.968 111.055 798.533 105.09 798.533 98.4771V95.7289C798.533 88.2674 799.986 81.7102 802.903 76.058C805.814 70.4057 809.818 66.0375 814.908 62.9547C820.004 59.8718 825.74 58.33 832.108 58.33C839.07 58.33 844.916 59.8272 849.646 62.8209C854.376 65.8141 857.914 70.0033 860.256 75.3876C862.598 80.7718 863.772 87.0163 863.772 94.1206V101.158H815.664C815.977 104.866 816.959 108.151 818.598 111.01C820.231 113.87 822.451 116.104 825.252 117.713C828.047 119.322 831.312 120.126 835.043 120.126C842.684 120.126 848.826 117.177 853.469 111.279L862.546 119.925C859.861 123.812 856.131 127.052 851.354 129.643ZM846.984 89.0953H816.001C816.773 83.5993 818.528 79.3325 821.259 76.2942C823.985 73.2553 827.582 71.7361 832.039 71.7361C837.042 71.7361 840.732 73.2443 843.097 76.2606C845.462 79.2763 846.758 83.1304 846.984 87.8222V89.0953ZM910.974 131.921C907.702 132.993 904.018 133.529 899.921 133.529C893.913 133.529 889.183 131.898 885.725 128.636C882.268 125.374 880.542 120.169 880.542 113.02V72.0013H868.531V59.6691H880.542V41.9753H897.533V59.6691H910.497V72.0013H897.533V111.88C897.533 114.919 898.166 116.986 899.445 118.08C900.717 119.175 902.629 119.722 905.174 119.722C906.993 119.722 908.928 119.499 910.974 119.052V131.921Z"
        fill="currentColor"
      />
      <path
        d="M136.267 152.495C136.267 159.76 136.267 163.392 133.891 165.192C131.516 166.993 128.019 166.012 121.024 164.049L8.63192 132.51C4.41793 131.328 2.31093 130.737 1.09248 129.129C-0.125977 127.522 -0.125977 125.333 -0.125977 120.957V47.0434C-0.125977 42.6667 -0.125977 40.4783 1.09248 38.8709C2.31093 37.2634 4.41792 36.6722 8.63191 35.4897L121.024 3.95096C128.019 1.98834 131.516 1.00703 133.891 2.80771C136.267 4.60839 136.267 8.24049 136.267 15.5047V152.495ZM27.9043 122.228L120.966 148.345V96.1133L27.9043 122.228ZM15.1738 110.111L108.217 84L15.1738 57.8887V110.111ZM27.9033 45.7725L120.966 71.8877V19.6553L27.9033 45.7725Z"
        fill="currentColor"
      />
    </svg>
  )
}

function KalshiWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 772 226" aria-hidden="true" className={className} fill="none">
      <path
        d="M255.677 58.1911C210.683 58.1911 183.381 78.5114 181.206 113.922H228.062C229.924 100.374 238.611 93.2917 253.814 93.2917C269.018 93.2917 277.396 100.064 277.088 110.842C276.775 119.156 271.501 122.852 258.16 124.7L238.923 127.164C195.484 132.398 175.002 148.717 175.002 177.967C175.002 207.218 195.48 226 229.611 226C251.331 226 267.776 218.302 278.017 203.522V222.61H326.422V117.924C326.422 78.5114 302.532 58.1911 255.677 58.1911ZM245.44 192.437C231.478 192.437 223.72 186.281 223.72 174.887C223.72 164.109 230.545 158.875 249.473 156.105L258.16 154.873C265.845 153.8 272.17 152.274 277.396 150.131V166.267C277.396 181.663 264.368 192.437 245.44 192.437ZM343.488 3.38607H393.135V222.61H343.488V3.38607ZM105.23 105.628L179.66 222.61H115.118L54.3009 121.934V222.61H0V3.38607H54.3009V99.102L119.464 3.38607H177.489L105.23 105.628ZM716.145 26.1705C716.145 12.0062 728.557 0 744.073 0C759.588 0 772 12.0062 772 26.1705C772 40.3347 759.588 52.3409 744.073 52.3409C728.557 52.3409 716.145 40.6407 716.145 26.1705ZM544.868 172.423C544.868 208.446 518.494 225.996 474.743 225.996C430.991 225.996 403.997 206.908 402.447 172.113H448.369C450.232 185.351 456.435 192.743 474.434 192.743C489.95 192.743 497.395 186.587 497.395 177.347C497.395 168.107 488.396 163.489 465.747 160.107C422.616 154.257 405.242 141.631 405.242 109.304C405.242 75.1293 436.582 58.1911 471.643 58.1911C509.186 58.1911 536.493 71.4293 540.218 108.688H495.225C493.054 96.9877 486.225 91.1376 471.951 91.1376C458.61 91.1376 451.161 97.2937 451.161 105.608C451.161 114.844 458.61 118.23 480.638 121.31C523.148 127.16 544.868 137.934 544.868 172.423ZM719.249 61.5771H768.896V222.61H719.249V61.5771ZM702.183 115.77V222.61H652.536V124.39C652.536 107.146 645.399 98.2197 629.884 98.2197C614.368 98.2197 603.51 108.072 603.51 127.47V222.61H553.863V3.38607H603.51V85.5617C611.32 70.1734 627.761 58.1911 651.603 58.1911C681.393 58.1911 702.179 76.9734 702.179 115.766L702.183 115.77Z"
        fill="currentColor"
      />
    </svg>
  )
}

function FeedSourceWordmark({ source, className }: { source: FeedSource; className?: string }) {
  if (source === "kalshi") {
    return <KalshiWordmark className={className} />
  }
  return <PolymarketWordmark className={className} />
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
  onSelectSource: (source: FeedSource) => void
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
  onSelectSource,
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
      <div className="rounded-[28px] border border-border/80 bg-card/80 px-5 py-5 shadow-sm shadow-black/[0.03]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <div className="inline-flex h-12 items-center gap-3 rounded-[22px] border border-border/80 bg-background/80 px-4 shadow-sm shadow-black/[0.03]">
              <span className="inline-flex size-7 items-center justify-center rounded-full border border-border bg-secondary/30 text-foreground">
                <XTwitterIcon className="size-3.5" />
              </span>
              <div className="leading-none">
                <p className="text-sm font-semibold text-foreground">X / Twitter</p>
                <p className="mt-1 text-[11px] font-medium text-muted-foreground">消息源</p>
              </div>
            </div>
            <div className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-[24px] border border-border/80 bg-background/80 p-2 shadow-sm shadow-black/[0.03]">
              {FEED_SOURCES.map((candidateSource) => {
                const candidateConfig = getFeedSourceConfig(candidateSource)
                const isActiveSource = candidateSource === source
                return (
                  <button
                    key={candidateSource}
                    type="button"
                    onClick={() => onSelectSource(candidateSource)}
                    aria-pressed={isActiveSource}
                    title={candidateConfig.label}
                    className={cn(
                      "group inline-flex h-12 min-w-[10.5rem] flex-1 items-center justify-center rounded-[18px] border px-4 transition-all sm:flex-none",
                      isActiveSource
                        ? "border-border bg-card text-foreground shadow-sm shadow-black/[0.06]"
                        : "border-transparent bg-transparent text-muted-foreground hover:border-border/80 hover:bg-card/70 hover:text-foreground"
                    )}
                  >
                    <span className="sr-only">{candidateConfig.label}</span>
                    <FeedSourceWordmark
                      source={candidateSource}
                      className={cn(
                        "w-auto transition-transform duration-200 group-hover:scale-[1.01]",
                        candidateSource === "kalshi" ? "h-[18px]" : "h-5"
                      )}
                    />
                  </button>
                )
              })}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={isSyncing} className="rounded-full px-4">
            <RefreshCcw className={cn("mr-1 size-3.5", isSyncing ? "animate-spin" : "")} />
            {refreshLabel}
          </Button>
        </div>

        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="inline-flex items-center rounded-2xl border border-border/80 bg-background/80 px-3 py-2 text-foreground shadow-sm shadow-black/[0.03]">
              <span className="sr-only">{sourceConfig.label}</span>
              <FeedSourceWordmark
                source={source}
                className={cn("w-auto", source === "kalshi" ? "h-[18px]" : "h-5")}
              />
            </h2>
            <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              @{sourceConfig.accountHandle}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
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
      </div>

      {!subscription?.enabled ? (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-secondary/20 p-6">
          <p className="text-sm font-medium text-foreground">当前消息源尚未开启</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {sourceConfig.label} 暂时不会自动同步。你仍然可以切换到其他消息源，或在全局设置里开启订阅。
          </p>
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
