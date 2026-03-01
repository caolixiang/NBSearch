"use client"

import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
  type SyntheticEvent,
} from "react"
import { hasTauriRuntime } from "@/app/runtime-info"
import { buildGrokChromeImageHeaders } from "@/infrastructure/http/chrome-image-headers"
import { runtimeFetch } from "@/infrastructure/http/runtime-fetch"
import { tauriTlsImageFetch } from "@/infrastructure/http/tauri-tls-image-fetch"

// Default off: keep TLS JA3/JA4 path as opt-in experiment.
const ENABLE_TLS_IMAGE_FETCH_EXPERIMENT = false

export function isAnchorImageNode(node: ReactNode): boolean {
  if (!isValidElement(node)) {
    return false
  }
  const props = node.props as { href?: unknown; children?: ReactNode }
  if (typeof props.href !== "string") {
    return false
  }
  const childNodes = Children.toArray(props.children).filter(
    (item) => !(typeof item === "string" && item.trim() === "")
  )
  return childNodes.length === 1 && isImageNode(childNodes[0])
}

export function isImageNode(node: ReactNode): boolean {
  if (!isValidElement(node)) {
    return false
  }
  const props = node.props as { src?: unknown }
  if (typeof props.src === "string" && props.src.trim() !== "") {
    return true
  }
  if (typeof node.type === "string" && node.type === "img") {
    return true
  }
  return isAnchorImageNode(node)
}

export function collectImageOnlyNodes(node: ReactNode): ReactNode[] | null {
  if (typeof node === "string") {
    return node.trim() ? null : []
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return []
  }

  if (isImageNode(node)) {
    return [node]
  }

  if (!isValidElement(node)) {
    return null
  }

  const props = node.props as { children?: ReactNode }
  if (props.children === undefined) {
    return null
  }

  const nested: ReactNode[] = []
  for (const child of Children.toArray(props.children)) {
    const rows = collectImageOnlyNodes(child)
    if (!rows) {
      return null
    }
    nested.push(...rows)
  }
  return nested
}

export function collectImageParagraphNodes(children: ReactNode): ReactNode[] | null {
  const rows: ReactNode[] = []
  for (const child of Children.toArray(children)) {
    const nested = collectImageOnlyNodes(child)
    if (!nested) {
      return null
    }
    rows.push(...nested)
  }
  return rows.length > 0 ? rows : null
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
      <div className="grok-md-image animate-pulse bg-secondary/40 h-full min-h-[160px] w-full rounded-[20px]" />
    )
  }

  if (runtimeLoading) {
    return <div className="grok-md-image animate-pulse bg-secondary/40 h-full min-h-[160px] w-full rounded-[20px]" />
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
      className="grok-md-image block h-auto max-h-[72vh] w-full rounded-[20px] bg-secondary/20 object-contain"
      data-grok-md-image="true"
    />
  )
})
