"use client"

import { useMemo } from "react"
import { Streamdown } from "streamdown"
import { cn } from "@/lib/utils"
import { normalizeAssistantMarkdown } from "./markdown-normalize"
import { MarkdownImage, collectImageParagraphNodes } from "./markdown-image"

export function MarkdownBody({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  if (!normalized) {
    return null
  }

  return (
    <Streamdown
      isAnimating={streaming}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
        p: ({ children }) => {
          const imageNodes = collectImageParagraphNodes(children)
          if (!imageNodes) {
            return <p className="leading-7">{children}</p>
          }

          const imageCount = imageNodes.length

          return (
            <div className="my-2 w-full">
              <div
                className={cn(
                  "grok-md-image-grid grid overflow-hidden",
                  imageCount === 1
                    ? "grok-md-image-grid-single grid-cols-1 max-w-[40rem] mx-auto rounded-[20px]"
                    : "grid-cols-2 gap-[2px] rounded-[24px] [&_.grok-md-image]:!m-0 [&_.grok-md-image]:aspect-square [&_.grok-md-image]:max-h-none [&_.grok-md-image]:rounded-none [&_.grok-md-image]:object-cover"
                )}
              >
                {imageNodes.map((node, index) => {
                  let cornerClass = ""
                  if (imageCount === 2) {
                    cornerClass = index === 0 ? "rounded-l-[24px]" : "rounded-r-[24px]"
                  } else if (imageCount === 3) {
                    if (index === 0) cornerClass = "rounded-tl-[24px]"
                    else if (index === 1) cornerClass = "rounded-tr-[24px]"
                    else if (index === 2) cornerClass = "rounded-b-[24px] col-span-2"
                  } else if (imageCount >= 4) {
                    if (index === 0) cornerClass = "rounded-tl-[24px]"
                    else if (index === 1) cornerClass = "rounded-tr-[24px]"
                    else if (index === imageCount - 2) cornerClass = "rounded-bl-[24px]"
                    else if (index === imageCount - 1) cornerClass = "rounded-br-[24px]"
                  }

                  return (
                    <div key={index} className={cn("relative overflow-hidden bg-secondary/20", cornerClass)}>
                      {node}
                    </div>
                  )
                })}
              </div>
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
        img: ({ src, alt }) => <MarkdownImage src={src || ""} alt={alt || ""} />,
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
    </Streamdown>
  )
}
