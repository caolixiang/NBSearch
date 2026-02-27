"use client"

import { Children, isValidElement, useMemo, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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

function normalizeAssistantMarkdown(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content.replace(/\r\n?/g, "\n")
  normalized = mergeConsecutiveImageLines(normalized)
  normalized = normalized.replace(/([^\n])(?=#{1,6}\s?)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/(^|\n)(#{1,6}\s[^\n-]+)-\s?/g, "$1$2\n- ")
  normalized = normalized.replace(/([\u4E00-\u9FFF）)])-(?=[\u4E00-\u9FFF0-9A-Za-z])/g, "$1\n- ")
  normalized = normalized.replace(/([^\n])(?=\d+\.\s)/g, "$1\n")
  normalized = normalized.replace(/\n{3,}/g, "\n\n")
  return normalized.trim()
}

function isImageNode(node: ReactNode): boolean {
  return isValidElement(node) && typeof node.type === "string" && node.type === "img"
}

export function MarkdownContent({ content }: { content: string }) {
  const normalized = useMemo(() => {
    return normalizeAssistantMarkdown(content)
  }, [content])

  return (
    <div className="space-y-0.5 text-foreground">
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
              return <div className="my-3">{nodes[0]}</div>
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
              className="h-auto w-full rounded-xl border border-border bg-secondary/20 object-cover"
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
    </div>
  )
}
