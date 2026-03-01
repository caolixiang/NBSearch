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
  const fallbackAttemptedRef = useRef(false)
  const swappedProtocolRef = useRef(false)

  useEffect(() => {
    setCurrentSrc(primarySrc)
    setFailed(false)
    fallbackAttemptedRef.current = false
    swappedProtocolRef.current = false
  }, [primarySrc])

  if (isStreaming) {
    return (
      <div className="grok-md-image animate-pulse bg-secondary/40 h-full min-h-[160px] w-full rounded-[20px]" />
    )
  }

  const handleError = (_event: SyntheticEvent<HTMLImageElement>) => {
    if (!fallbackAttemptedRef.current && fallbackSrc) {
      fallbackAttemptedRef.current = true
      setCurrentSrc(fallbackSrc)
      return
    }

    if (swappedProtocolRef.current) {
      setFailed(true)
      return
    }
    const value = (currentSrc || "").trim()
    if (value.startsWith("https://")) {
      swappedProtocolRef.current = true
      setFailed(false)
      setCurrentSrc(`http://${value.slice("https://".length)}`)
      return
    }
    if (value.startsWith("http://")) {
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
    fallbackAttemptedRef.current = false
    swappedProtocolRef.current = false
    setFailed(false)
    const separator = value.includes("?") ? "&" : "?"
    setCurrentSrc(`${value}${separator}retry=${Date.now()}`)
  }

  if (failed || !currentSrc.trim()) {
    const fallbackLink = currentSrc.trim() || primarySrc || ""
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
      referrerPolicy="no-referrer"
      onError={handleError}
      className="grok-md-image block h-auto max-h-[72vh] w-full rounded-[20px] bg-secondary/20 object-contain"
      data-grok-md-image="true"
    />
  )
})
