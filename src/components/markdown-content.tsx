"use client"

import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

function normalizeAssistantMarkdown(content: string): string {
  if (!content) {
    return ""
  }

  let normalized = content.replace(/\r\n?/g, "\n")
  normalized = normalized.replace(/([^\n])(?=#{1,6}\s?)/g, "$1\n")
  normalized = normalized.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3")
  normalized = normalized.replace(/(^|\n)(#{1,6}\s[^\n-]+)-\s?/g, "$1$2\n- ")
  normalized = normalized.replace(/([\u4E00-\u9FFF）)])-(?=[\u4E00-\u9FFF0-9A-Za-z])/g, "$1\n- ")
  normalized = normalized.replace(/([^\n])(?=\d+\.\s)/g, "$1\n")
  normalized = normalized.replace(/\n{3,}/g, "\n\n")
  return normalized.trim()
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
          p: ({ children }) => <p className="leading-7">{children}</p>,
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
