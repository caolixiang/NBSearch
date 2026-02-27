"use client"

import { Children, isValidElement, useEffect, useMemo, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

type TextSection = {
  type: "text"
  value: string
}

type ThinkSection = {
  type: "think"
  value: string
  open: boolean
  thinking: boolean
}

type MarkdownSection = TextSection | ThinkSection

type ThinkItem = {
  type: string
  body: string
}

function isImageMarkdownLine(line: string): boolean {
  return /^\s*!\[[^\]]*]\([^)]+\)\s*$/.test(line.trim())
}

function mergeConsecutiveImageLines(content: string): string {
  const lines = content.split("\n")
  const merged: string[] = []
  let index = 0

  while (index < lines.length) {
    const currentLine = lines[index]?.trim() || ""
    if (!isImageMarkdownLine(currentLine)) {
      merged.push(lines[index] || "")
      index += 1
      continue
    }

    const imageLines = [currentLine]
    index += 1

    while (index < lines.length) {
      const line = lines[index]?.trim() || ""
      if (isImageMarkdownLine(line)) {
        imageLines.push(line)
        index += 1
        continue
      }

      if (line === "") {
        let lookahead = index + 1
        while (lookahead < lines.length && (lines[lookahead]?.trim() || "") === "") {
          lookahead += 1
        }
        const next = lines[lookahead]?.trim() || ""
        if (isImageMarkdownLine(next)) {
          imageLines.push(next)
          index = lookahead + 1
          continue
        }
      }
      break
    }

    merged.push(imageLines.join(" "))
    merged.push("")
  }

  while (merged.length > 0 && merged[merged.length - 1] === "") {
    merged.pop()
  }
  return merged.join("\n")
}

export function normalizeAssistantMarkdown(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content.replace(/\r\n?/g, "\n")
  normalized = normalized.replace(/<\/think>/gi, "")
  normalized = mergeConsecutiveImageLines(normalized)
  normalized = normalized.replace(/([^\n])(?=#{1,6}\s?)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/(^|\n)(#{1,6}\s[^\n-]+)-\s?/g, "$1$2\n- ")
  normalized = normalized.replace(/([\u4E00-\u9FFF）)])-(?=[\u4E00-\u9FFF0-9A-Za-z])/g, "$1\n- ")
  normalized = normalized.replace(/([^\n])(?=\d+\.\s)/g, "$1\n")
  normalized = normalized.replace(/\n{3,}/g, "\n\n")
  return normalized.trim()
}

export function parseThinkSections(raw: string): MarkdownSection[] {
  const text = raw || ""
  if (!text.trim()) {
    return []
  }

  const sections: MarkdownSection[] = []
  const lower = text.toLowerCase()
  const closeTag = "</think>"
  let cursor = 0

  while (cursor < text.length) {
    const start = lower.indexOf("<think", cursor)
    if (start < 0) {
      break
    }
    const startTagEnd = text.indexOf(">", start)
    if (startTagEnd < 0) {
      break
    }

    const before = text.slice(cursor, start)
    if (before.trim()) {
      sections.push({
        type: "text",
        value: before.replace(/<\/think>/gi, ""),
      })
    }

    const startTag = text.slice(start, startTagEnd + 1)
    const open = /\bopen\b/i.test(startTag)
    const close = lower.indexOf(closeTag, startTagEnd + 1)

    if (close < 0) {
      const thinkBody = text.slice(startTagEnd + 1)
      sections.push({
        type: "think",
        value: thinkBody,
        open: true,
        thinking: true,
      })
      cursor = text.length
      break
    }

    const thinkBody = text.slice(startTagEnd + 1, close)
    sections.push({
      type: "think",
      value: thinkBody,
      open,
      thinking: false,
    })
    cursor = close + closeTag.length
  }

  const tail = text.slice(cursor).replace(/<\/think>/gi, "")
  if (tail.trim()) {
    sections.push({
      type: "text",
      value: tail,
    })
  }

  if (sections.length === 0) {
    return [
      {
        type: "text",
        value: text.replace(/<\/think>/gi, ""),
      },
    ]
  }
  return sections
}

function parseThinkItems(content: string): ThinkItem[] {
  const items: ThinkItem[] = []
  const pattern = /\[([A-Za-z][A-Za-z0-9 _-]{0,32})\]\s*([\s\S]*?)(?=\s*\[[A-Za-z][A-Za-z0-9 _-]{0,32}\]\s*|$)/g
  let match: RegExpExecArray | null = pattern.exec(content)

  while (match) {
    const type = (match[1] || "").trim()
    const body = (match[2] || "").trim()
    if (type) {
      items.push({ type, body })
    }
    match = pattern.exec(content)
  }
  return items
}

function thinkItemTagClass(type: string): string {
  return "bg-secondary/80 text-foreground border-border"
}

function isWebSearchThinkItemType(type: string): boolean {
  const key = type.trim().toLowerCase().replace(/\s+/g, "")
  return key.includes("websearch")
}

function thinkItemDisplayLabel(type: string): string {
  if (isWebSearchThinkItemType(type)) {
    return "已经搜索网络"
  }
  return type
}

function WebSearchPrefixIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4 text-muted-foreground transition-all duration-200"
      aria-hidden="true"
    >
      <path
        d="M9 3a6 6 0 104.472 10.016l3.256 3.256a1 1 0 001.416-1.416l-3.256-3.256A6 6 0 009 3zm0 2a4 4 0 100 8 4 4 0 000-8z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </svg>
  )
}

function isAnchorImageNode(node: ReactNode): boolean {
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

function isImageNode(node: ReactNode): boolean {
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

function MarkdownBody({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  if (!normalized) {
    return null
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
        p: ({ children }) => {
          const nodes = Children.toArray(children).filter(
            (item) => !(typeof item === "string" && item.trim() === "")
          )
          const imageOnlyParagraph = nodes.length > 0 && nodes.every((item) => isImageNode(item))

          if (!imageOnlyParagraph) {
            return <p className="leading-7">{children}</p>
          }

          if (nodes.length === 1) {
            return (
              <div className="my-2 inline-block w-full align-top sm:w-[calc(50%-0.375rem)] sm:pr-1.5">
                <div className="overflow-hidden rounded-xl border border-border bg-secondary/20">{nodes[0]}</div>
              </div>
            )
          }

          return (
            <div className="my-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {nodes.map((node, index) => (
                <div key={index} className="overflow-hidden rounded-xl border border-border bg-secondary/20">
                  {node}
                </div>
              ))}
            </div>
          )
        },
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
        li: ({ children }) => <li className="leading-7">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-claude-sienna underline decoration-claude-sienna/50 underline-offset-2"
            target="_blank"
            rel="noreferrer noopener"
          >
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-claude-sienna pl-3 text-muted-foreground italic">
            {children}
          </blockquote>
        ),
        img: ({ src, alt }) => (
          <img
            src={src || ""}
            alt={alt || ""}
            loading="lazy"
            className="h-auto max-h-[380px] w-full rounded-xl border border-border bg-secondary/20 object-contain"
          />
        ),
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-secondary/40 p-3">{children}</pre>
        ),
        code: ({ className, children }) => {
          const isBlock = Boolean(className)
          if (isBlock) {
            return <code className="font-mono text-sm">{children}</code>
          }
          return (
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-sm text-foreground">
              {children}
            </code>
          )
        },
        hr: () => <hr className="my-3 border-border" />,
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-secondary/60">{children}</thead>,
        th: ({ children }) => <th className="border border-border px-3 py-2 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-border px-3 py-2 align-top">{children}</td>,
      }}
    >
      {normalized}
    </ReactMarkdown>
  )
}

function ThinkBlock({ content, open, thinking }: { content: string; open: boolean; thinking: boolean }) {
  const [expanded, setExpanded] = useState(open || thinking)

  useEffect(() => {
    if (thinking) {
      setExpanded(true)
    }
  }, [thinking])

  const items = useMemo(() => parseThinkItems(content), [content])
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])

  return (
    <div className="my-2 w-full">
      <button
        type="button"
        className="inline-flex items-center gap-2 text-xs text-muted-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          className={cn(
            "inline-flex h-4 w-4 rounded-full bg-[conic-gradient(from_180deg,#f59e0b,#f97316,#22c55e,#0ea5e9,#f59e0b)]",
            thinking ? "think-summary-active" : ""
          )}
        />
        <span>{thinking ? "思考中" : "思考"}</span>
        <span
          className={cn(
            "ml-0.5 inline-block h-2 w-2 rotate-45 border-b border-r border-muted-foreground transition-transform duration-200",
            expanded ? "rotate-[225deg]" : ""
          )}
        />
      </button>

      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-out",
          expanded ? "mt-2 max-h-[60vh] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="max-h-[60vh] overflow-auto rounded-xl border border-border/80 bg-secondary/30 p-3 pr-2 text-xs text-muted-foreground">
          {items.length > 0 ? (
            <div className="space-y-2">
              {items.map((item, index) => (
                <div key={`${item.type}-${index}`} className="rounded-lg border border-border bg-background/70 p-2">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      thinkItemTagClass(item.type)
                    )}
                  >
                    {isWebSearchThinkItemType(item.type) ? <WebSearchPrefixIcon /> : null}
                    {thinkItemDisplayLabel(item.type)}
                  </span>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
                    {item.body || "（空）"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <MarkdownBody content={normalized || "（空）"} />
          )}
        </div>
      </div>
    </div>
  )
}

export function MarkdownContent({ content }: { content: string }) {
  const sections = useMemo(() => parseThinkSections(content), [content])

  if (sections.length === 0) {
    return null
  }

  return (
    <div className="space-y-1 text-foreground">
      {sections.map((section, index) => {
        if (section.type === "think") {
          return (
            <ThinkBlock
              key={`think-${index}`}
              content={section.value}
              open={section.open}
              thinking={section.thinking}
            />
          )
        }
        return <MarkdownBody key={`text-${index}`} content={section.value} />
      })}
    </div>
  )
}
