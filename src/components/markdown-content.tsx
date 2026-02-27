"use client"

import { useMemo } from "react"

function parseInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const regex = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[1]) {
      parts.push(<strong key={match.index} className="font-semibold">{match[2]}</strong>)
    } else if (match[3]) {
      parts.push(
        <code key={match.index} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-sm text-foreground">
          {match[4]}
        </code>
      )
    } else if (match[5]) {
      parts.push(
        <a key={match.index} href={match[7]} className="text-claude-sienna underline" target="_blank" rel="noopener noreferrer">
          {match[6]}
        </a>
      )
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

export function MarkdownContent({ content }: { content: string }) {
  const rendered = useMemo(() => {
    const lines = content.split("\n")
    const elements: React.ReactNode[] = []
    let inCodeBlock = false
    let codeLines: string[] = []
    let codeLang = ""

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith("```")) {
        if (!inCodeBlock) {
          inCodeBlock = true
          codeLang = line.slice(3).trim()
          codeLines = []
        } else {
          inCodeBlock = false
          elements.push(
            <div key={`code-${i}`} className="my-3 overflow-hidden rounded-lg border border-border">
              {codeLang && (
                <div className="border-b border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground font-mono">
                  {codeLang}
                </div>
              )}
              <pre className="overflow-x-auto bg-secondary/50 p-3">
                <code className="text-sm font-mono text-foreground">{codeLines.join("\n")}</code>
              </pre>
            </div>
          )
        }
        continue
      }

      if (inCodeBlock) {
        codeLines.push(line)
        continue
      }

      if (line.startsWith("### ")) {
        elements.push(<h3 key={i} className="mt-4 mb-2 text-base font-semibold text-foreground">{parseInlineMarkdown(line.slice(4))}</h3>)
      } else if (line.startsWith("## ")) {
        elements.push(<h2 key={i} className="mt-4 mb-2 text-lg font-semibold text-foreground">{parseInlineMarkdown(line.slice(3))}</h2>)
      } else if (line.startsWith("# ")) {
        elements.push(<h1 key={i} className="mt-4 mb-2 text-xl font-bold text-foreground">{parseInlineMarkdown(line.slice(2))}</h1>)
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        elements.push(
          <li key={i} className="ml-4 list-disc text-foreground leading-relaxed">
            {parseInlineMarkdown(line.slice(2))}
          </li>
        )
      } else if (/^\d+\.\s/.test(line)) {
        const text = line.replace(/^\d+\.\s/, "")
        elements.push(
          <li key={i} className="ml-4 list-decimal text-foreground leading-relaxed">
            {parseInlineMarkdown(text)}
          </li>
        )
      } else if (line.startsWith("> ")) {
        elements.push(
          <blockquote key={i} className="my-2 border-l-3 border-claude-sienna pl-3 text-muted-foreground italic">
            {parseInlineMarkdown(line.slice(2))}
          </blockquote>
        )
      } else if (line.trim() === "") {
        elements.push(<div key={i} className="h-2" />)
      } else {
        elements.push(
          <p key={i} className="text-foreground leading-relaxed">
            {parseInlineMarkdown(line)}
          </p>
        )
      }
    }

    return elements
  }, [content])

  return <div className="prose-claude space-y-0.5">{rendered}</div>
}
