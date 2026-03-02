"use client"

import {
  memo,
  useEffect,
  useRef,
  useState,
  useMemo,
  type SyntheticEvent,
} from "react"
import { Download, Video } from "lucide-react"
import { hasTauriRuntime } from "@/app/runtime-info"
import { buildGrokChromeImageHeaders } from "@/infrastructure/http/chrome-image-headers"
import { runtimeFetch } from "@/infrastructure/http/runtime-fetch"
import { tauriTlsImageFetch } from "@/infrastructure/http/tauri-tls-image-fetch"

// Default off: keep TLS JA3/JA4 path as opt-in experiment.
const ENABLE_TLS_IMAGE_FETCH_EXPERIMENT = false

function stripFallbackSuffix(value: string): string {
  const input = value.trim()
  const marker = "#fallback="
  const index = input.indexOf(marker)
  if (index < 0) {
    return input
  }
  return input.slice(0, index)
}

function guessDownloadFileName(url: string): string {
  const source = stripFallbackSuffix(url)
  try {
    const parsed = new URL(source)
    const segments = parsed.pathname.split("/").filter(Boolean)
    const tail = segments[segments.length - 1] || "image.jpg"
    if (/\.[a-z0-9]{2,8}$/i.test(tail)) {
      return tail
    }
    return `${tail}.jpg`
  } catch {
    return "image.jpg"
  }
}

function triggerDownload(href: string, fileName: string): void {
  const anchor = document.createElement("a")
  anchor.href = href
  anchor.download = fileName
  anchor.rel = "noreferrer noopener"
  anchor.target = "_blank"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function ImageCardActions({ src }: { src: string }) {
  const isTauri = hasTauriRuntime()
  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "done" | "error">("idle")

  const setDownloadStateWithReset = (state: "done" | "error") => {
    setDownloadState(state)
    window.setTimeout(() => {
      setDownloadState((prev) => (prev === "loading" ? prev : "idle"))
    }, 4200)
  }

  const onDownload = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    const source = stripFallbackSuffix(src)
    if (!source) {
      return
    }
    setDownloadState("loading")
    const fileName = guessDownloadFileName(source)

    if (/^(?:blob:|data:)/i.test(source)) {
      triggerDownload(source, fileName)
      setDownloadStateWithReset("done")
      return
    }

    if (isTauri) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { invoke } = await import("@tauri-apps/api/core")
        const targetPath = await save({
          defaultPath: fileName,
          title: "保存图片",
        })
        if (!targetPath) {
          setDownloadState("idle")
          return
        }
        await invoke("download_image_to_downloads", {
          url: source,
          fileName,
          destinationPath: targetPath,
        })
        setDownloadStateWithReset("done")
        return
      } catch {
        try {
          const { invoke } = await import("@tauri-apps/api/core")
          await invoke("download_image_to_downloads", {
            url: source,
            fileName,
            destinationPath: undefined,
            headers: buildGrokChromeImageHeaders(),
          })
          setDownloadStateWithReset("done")
          return
        } catch {
          // Fall through.
        }
      }
    }

    try {
      const response = await runtimeFetch(source, {
        method: "GET",
        ...(isTauri ? { headers: buildGrokChromeImageHeaders() } : {}),
      })
      if (!response.ok) {
        throw new Error(`download_http_${response.status}`)
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      triggerDownload(objectUrl, fileName)
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl)
      }, 1000)
      setDownloadStateWithReset("done")
    } catch {
      try {
        if (isTauri) {
          const { openUrl } = await import("@tauri-apps/plugin-opener")
          await openUrl(source)
          setDownloadStateWithReset("done")
          return
        }
      } catch {
        // Fall through.
      }

      try {
        triggerDownload(source, fileName)
        setDownloadStateWithReset("done")
      } catch {
        setDownloadStateWithReset("error")
      }
    }
  }

  const onVideo = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const iconButtonClassName =
    "pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-background/94 text-foreground shadow-sm backdrop-blur transition-all duration-200 ease-in-out group-hover/image:scale-100 group-hover/image:opacity-100 scale-75 opacity-0 border border-black/10 hover:bg-background"
  const downloadStatusPinned = downloadState !== "idle"
  const downloadStatusLabel =
    downloadState === "loading"
      ? "下载中"
      : downloadState === "done"
        ? "已下载"
        : downloadState === "error"
          ? "下载失败"
          : "下载"
  const downloadStatusClassName = downloadStatusPinned
    ? "pointer-events-none absolute bottom-[calc(100%+8px)] right-0 rounded-[16px] border border-black/10 bg-background/96 px-4 py-1 text-base leading-7 text-foreground opacity-100 shadow-sm backdrop-blur transition-all duration-200 ease-in-out translate-y-0 whitespace-nowrap"
    : "pointer-events-none absolute bottom-[calc(100%+8px)] right-0 rounded-[16px] border border-black/10 bg-background/96 px-4 py-1 text-base leading-7 text-foreground opacity-0 shadow-sm backdrop-blur transition-all duration-200 ease-in-out group-hover/download:translate-y-0 group-hover/download:opacity-100 translate-y-1 whitespace-nowrap"

  return (
    <div className="pointer-events-none absolute bottom-2 right-2 z-20">
      <div className="flex h-8 w-[68px] items-center gap-1">
        <div className="group/video relative">
          <span className="pointer-events-none absolute bottom-[calc(100%+8px)] right-0 rounded-[16px] border border-black/10 bg-background/96 px-4 py-1 text-base leading-7 text-foreground opacity-0 shadow-sm backdrop-blur transition-all duration-200 ease-in-out group-hover/video:translate-y-0 group-hover/video:opacity-100 translate-y-1 whitespace-nowrap">
            创作视频
          </span>
          <button
            type="button"
            onClick={onVideo}
            aria-label="创作视频"
            className={iconButtonClassName}
          >
            <Video className="size-4" />
          </button>
        </div>
        <div className="group/download relative">
          <span className={downloadStatusClassName}>
            {downloadStatusLabel}
          </span>
          <button
            type="button"
            onClick={onDownload}
            aria-label="下载"
            disabled={downloadState === "loading"}
            className={iconButtonClassName}
          >
            <Download className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

export const MarkdownImage = memo(function({
  src,
  alt,
  isStreaming,
}: {
  src: string
  alt: string
  isStreaming?: boolean
}) {
  const isTauri = hasTauriRuntime()
  const { primarySrc, fallbackSrc } = useMemo(() => {
    const raw = (src || "").trim()
    const hashIndex = raw.indexOf("#fallback=")
    if (hashIndex >= 0) {
      try {
        const primary = raw.substring(0, hashIndex)
        const fallback = decodeURIComponent(raw.substring(hashIndex + "#fallback=".length))
        return { primarySrc: primary, fallbackSrc: fallback }
      } catch (e) {
        // Fallback to raw if decode fails
      }
    }
    return { primarySrc: raw, fallbackSrc: "" }
  }, [src])

  const [currentSrc, setCurrentSrc] = useState(primarySrc)
  const [failed, setFailed] = useState(false)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const fallbackAttemptedRef = useRef(false)
  const swappedProtocolRef = useRef(false)
  const objectUrlRef = useRef<string>("")

  const swapProtocol = (value: string): string => {
    const input = value.trim()
    if (input.startsWith("https://")) {
      return `http://${input.slice("https://".length)}`
    }
    if (input.startsWith("http://")) {
      return `https://${input.slice("http://".length)}`
    }
    return input
  }

  const withRetryNonce = (value: string): string => {
    if (!value || !/^https?:\/\//i.test(value)) {
      return value
    }
    if (reloadNonce <= 0) {
      return value
    }
    const separator = value.includes("?") ? "&" : "?"
    return `${value}${separator}retry=${reloadNonce}`
  }

  const buildRuntimeCandidates = (primary: string, fallback: string): string[] => {
    const set = new Set<string>()
    const push = (value: string) => {
      const normalized = value.trim()
      if (!normalized) {
        return
      }
      set.add(withRetryNonce(normalized))
    }

    push(primary)
    push(fallback)

    const swappedPrimary = swapProtocol(primary)
    if (swappedPrimary !== primary) {
      push(swappedPrimary)
    }
    const swappedFallback = swapProtocol(fallback)
    if (swappedFallback !== fallback) {
      push(swappedFallback)
    }

    return Array.from(set)
  }

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = ""
      }
    }
  }, [])

  const loadViaTlsProfile = async (url: string): Promise<string> => {
    const target = (url || "").trim()
    if (!/^https?:\/\//i.test(target)) {
      return ""
    }

    const blob = await tauriTlsImageFetch(target, buildGrokChromeImageHeaders())
    if (!blob || blob.size <= 0) {
      return ""
    }
    return URL.createObjectURL(blob)
  }

  const loadViaRuntimeFetch = async (url: string): Promise<string> => {
    const target = (url || "").trim()
    if (!/^https?:\/\//i.test(target)) {
      return ""
    }

    const cachedBlob = await tauriTlsImageFetch(target, buildGrokChromeImageHeaders())
    if (cachedBlob && cachedBlob.size > 0) {
      return URL.createObjectURL(cachedBlob)
    }

    const init: RequestInit = {
      method: "GET",
      headers: buildGrokChromeImageHeaders(),
    }

    try {
      const response = await runtimeFetch(target, init)
      if (!response.ok) {
        return ""
      }
      const blob = await response.blob()
      if (!blob || blob.size <= 0) {
        return ""
      }
      return URL.createObjectURL(blob)
    } catch {
      return ""
    }
  }

  useEffect(() => {
    let cancelled = false

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = ""
    }

    setFailed(false)
    fallbackAttemptedRef.current = false
    swappedProtocolRef.current = false

    const primary = (primarySrc || "").trim()
    const fallback = (fallbackSrc || "").trim()

    if (isStreaming) {
      setRuntimeLoading(false)
      setCurrentSrc(primary || fallback || "")
      return () => {
        cancelled = true
      }
    }

    if (!primary) {
      setCurrentSrc("")
      setRuntimeLoading(false)
      setFailed(true)
      return () => {
        cancelled = true
      }
    }

    const shouldProxyByRuntime = isTauri && /^https?:\/\//i.test(primary)
    if (!shouldProxyByRuntime) {
      setRuntimeLoading(false)
      setCurrentSrc(primary)
      return () => {
        cancelled = true
      }
    }

    const load = async () => {
      setCurrentSrc("")
      setRuntimeLoading(true)

      const candidates = buildRuntimeCandidates(primary, fallback)
      for (const candidate of candidates) {
        let objectUrl = ""
        if (ENABLE_TLS_IMAGE_FETCH_EXPERIMENT) {
          objectUrl = await loadViaTlsProfile(candidate)
        }
        if (!objectUrl) {
          objectUrl = await loadViaRuntimeFetch(candidate)
        }
        if (cancelled) {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl)
          }
          return
        }
        if (!objectUrl) {
          continue
        }
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current)
        }
        objectUrlRef.current = objectUrl
        setCurrentSrc(objectUrl)
        setRuntimeLoading(false)
        setFailed(false)
        return
      }

      if (!cancelled) {
        setRuntimeLoading(false)
        // Safety fallback: if runtime fetch path is blocked, still allow native image loading.
        setCurrentSrc(primary || fallback || "")
        setFailed(!(primary || fallback))
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [primarySrc, fallbackSrc, isStreaming, isTauri, reloadNonce])

  if (isStreaming) {
    return (
      <div className="grok-md-image animate-pulse bg-secondary/40 h-full min-h-[160px] w-full rounded-[24px]" />
    )
  }

  if (runtimeLoading) {
    return <div className="grok-md-image animate-pulse bg-secondary/40 h-full min-h-[160px] w-full rounded-[24px]" />
  }

  const handleError = (_event: SyntheticEvent<HTMLImageElement>) => {
    if (!fallbackAttemptedRef.current && fallbackSrc) {
      fallbackAttemptedRef.current = true
      setCurrentSrc(fallbackSrc)
      return
    }

    const value = (currentSrc || "").trim()
    if (!swappedProtocolRef.current && value.startsWith("https://")) {
      swappedProtocolRef.current = true
      setFailed(false)
      setCurrentSrc(`http://${value.slice("https://".length)}`)
      return
    }
    if (!swappedProtocolRef.current && value.startsWith("http://")) {
      swappedProtocolRef.current = true
      setFailed(false)
      setCurrentSrc(`https://${value.slice("http://".length)}`)
      return
    }

    setFailed(true)
  }

  const retryImage = () => {
    const value = (primarySrc || "").trim()
    if (!value) {
      return
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = ""
    }
    setReloadNonce((value) => value + 1)
    setFailed(false)
    if (!isTauri) {
      fallbackAttemptedRef.current = false
      swappedProtocolRef.current = false
      const separator = value.includes("?") ? "&" : "?"
      setCurrentSrc(`${value}${separator}retry=${Date.now()}`)
      return
    }
    setCurrentSrc("")
  }

  if (failed || !currentSrc.trim()) {
    const fallbackLink = (primarySrc || fallbackSrc || "").trim()
    return (
      <div className="flex w-full flex-col items-center justify-center gap-2 bg-secondary/30 px-4 py-4 text-center text-sm text-muted-foreground">
        <span>图片加载失败</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full bg-secondary px-3 py-1 text-xs text-foreground transition-colors hover:bg-secondary/80"
            onClick={retryImage}
          >
            重试
          </button>
          {fallbackLink ? (
            <a
              href={fallbackLink}
              className="text-xs text-claude-sienna underline decoration-claude-sienna/45 underline-offset-2"
              target="_blank"
              rel="noreferrer noopener"
            >
              打开原图
            </a>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <img
      src={currentSrc}
      alt={alt || ""}
      loading="lazy"
      onError={handleError}
      className="grok-md-image block h-auto max-h-[72vh] w-full rounded-[24px] bg-secondary/20 object-contain"
      data-grok-md-image="true"
    />
  )
})
