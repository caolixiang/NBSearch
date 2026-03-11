"use client"

import { Children, type ReactNode, useMemo } from "react"
import { Streamdown, defaultRehypePlugins } from "streamdown"
import { cn } from "@/lib/utils"
import { normalizeAssistantMarkdown } from "./markdown-normalize"
import { ImageCardActions, MarkdownImage } from "./markdown-image"
import { collectImageParagraphNodes, extractImageSource, isGeneratedImageNode, isImageNode } from "./markdown-image-nodes"
import { harden } from "rehype-harden"

function flattenTextContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node)
  }
  if (!node || typeof node === "boolean") {
    return ""
  }
  const nested = (node as { props?: { children?: ReactNode } }).props?.children
  if (nested === undefined) {
    return ""
  }
  return Children.toArray(nested)
    .map((child) => flattenTextContent(child))
    .join("")
}

function normalizeHostLabel(value: string): string {
  if (!value) {
    return ""
  }
  try {
    return new URL(value).host.replace(/^www\./i, "")
  } catch {
    return ""
  }
}

function isCitationPillLink(href: string | undefined, children: ReactNode): boolean {
  if (!href) {
    return false
  }
  const text = flattenTextContent(children).trim()
  if (!text) {
    return false
  }
  return text === normalizeHostLabel(href)
}

export function MarkdownBody({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const normalized = useMemo(() => normalizeAssistantMarkdown(content), [content])
  const rehypePlugins = useMemo(
    () =>
      [
        defaultRehypePlugins.raw,
        defaultRehypePlugins.sanitize,
        [
          harden,
          {
            allowedImagePrefixes: ["*"],
            allowedLinkPrefixes: ["*"],
            allowedProtocols: ["*"],
            allowDataImages: true,
            imageBlockPolicy: "remove",
          },
        ],
      ] as any,
    []
  )
  if (!normalized) {
    return null
  }

  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      rehypePlugins={rehypePlugins}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-4 mt-6 text-3xl leading-tight font-bold tracking-tight text-foreground">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-3 mt-5 text-2xl leading-tight font-semibold tracking-tight text-foreground">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2.5 mt-4.5 text-xl leading-snug font-semibold text-foreground">{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 className="mb-2 mt-4 text-lg leading-snug font-semibold text-foreground">{children}</h4>
        ),
        p: ({ children }) => {
          if (streaming) {
            return <p className="leading-7">{children}</p>
          }

          const imageNodes = collectImageParagraphNodes(children)
          if (!imageNodes) {
            return <p className="leading-7">{children}</p>
          }

          const imageCount = imageNodes.length
          const allGeneratedImages = imageCount > 0 && imageNodes.every((node) => isGeneratedImageNode(node))
          const isSingleGeneratedImage = imageCount === 1 && allGeneratedImages
          const isSingleNonGeneratedImage = imageCount === 1 && !allGeneratedImages
          const isTwoNonGeneratedImages = imageCount === 2 && !allGeneratedImages
          const isNonGeneratedGallery = imageCount > 1 && !allGeneratedImages

          let gridClass = "grid-cols-1"
          if (imageCount === 2) gridClass = "grid-cols-2"
          else if (imageCount === 3) gridClass = "grid-cols-3"
          else if (imageCount >= 4) gridClass = "grid-cols-4"

          return (
            <div
              className={cn(
                "my-2",
                isTwoNonGeneratedImages ? "clear-both mx-auto flex w-fit max-w-full flex-col justify-center gap-1" : "w-full"
              )}
            >
              <div
                className={cn(
                  "grok-md-image-grid grid gap-2",
                  imageCount === 1
                    ? cn(
                        "grok-md-image-grid-single grid-cols-1 [&_.grok-md-image]:rounded-[24px]!",
                        isSingleGeneratedImage
                          ? "w-fit max-w-[75%] ml-auto mr-0 [&_a]:inline-block [&_a]:max-w-full [&_.grok-md-image]:w-auto! [&_.grok-md-image]:max-w-full!"
                          : "w-full max-w-none mx-0 [&_a]:inline-block [&_a]:max-w-full [&_.grok-md-image]:w-auto! [&_.grok-md-image]:max-w-full! [&_.grok-md-image]:h-auto! [&_.grok-md-image]:max-h-[448px]! [&_.grok-md-image]:object-contain! [&_.grok-md-image]:rounded-lg! [&_.grok-md-image]:bg-transparent!"
                      )
                    : gridClass,
                  isTwoNonGeneratedImages ? "mx-auto w-fit max-w-full grid-cols-2" : "",
                  isNonGeneratedGallery
                    ? "[&_.grok-md-image]:m-0! [&_.grok-md-image]:block! [&_.grok-md-image]:w-full! [&_.grok-md-image]:h-full! [&_.grok-md-image]:max-h-none! [&_.grok-md-image]:object-cover! [&_.grok-md-image]:rounded-lg! [&_.grok-md-image]:bg-transparent! [&_a]:block [&_a]:w-full [&_a]:h-full"
                    : "",
                  imageCount > 1 && allGeneratedImages
                    ? "grok-md-image-grid-generated w-[75%] max-w-none ml-auto mr-0 grid-cols-2 gap-1.5 [&_a]:block [&_a]:w-full [&_.grok-md-image]:rounded-[24px]! [&_.grok-md-image]:max-h-[72vh]! [&_.grok-md-image]:bg-transparent!"
                    : ""
                )}
              >
                {imageNodes.map((node, index) => (
                  <div
                    key={index}
                    className={cn(
                      "relative group/image overflow-hidden rounded-[24px]",
                      imageCount === 1
                        ? cn(
                            isSingleGeneratedImage
                              ? "w-fit max-w-[75%] ml-auto mr-0"
                              : "flex w-full justify-center rounded-lg"
                          )
                        : isNonGeneratedGallery
                          ? isTwoNonGeneratedImages
                            ? "h-full w-full max-h-56 max-w-88"
                            : "h-52 w-full"
                        : "w-full",
                      ""
                    )}
                  >
                    {node}
                    {allGeneratedImages ? (
                      <ImageCardActions src={extractImageSource(node)} />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )
        },
        ul: ({ children, className, ...props }) => (
          <ul {...props} className={cn("my-2 list-disc space-y-1 pl-6", className)}>
            {children}
          </ul>
        ),
        ol: ({ children, className, ...props }) => (
          <ol {...props} className={cn("my-2 list-decimal space-y-1 pl-6", className)}>
            {children}
          </ol>
        ),
        li: ({ children, className, ...props }) => (
          <li {...props} className={cn("leading-7", className)}>
            {children}
          </li>
        ),
        a: ({ href, children }) => {
          const nonEmptyChildren = Children.toArray(children).filter(
            (child) => !(typeof child === "string" && child.trim() === "")
          )
          const imageOnlyLink = nonEmptyChildren.length === 1 && isImageNode(nonEmptyChildren[0])
          const citationPillLink = !imageOnlyLink && isCitationPillLink(href, children)

          return (
            <a
              href={href}
              className={cn(
                imageOnlyLink
                  ? "block w-full"
                  : citationPillLink
                    ? "inline-flex items-center rounded-full border border-black/10 bg-secondary/30 px-3 py-1 text-[15px] leading-none text-muted-foreground no-underline align-middle transition-colors hover:bg-secondary/50 hover:text-foreground"
                    : "text-claude-sienna underline decoration-claude-sienna/50 underline-offset-2"
              )}
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </a>
          )
        },
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-2 border-claude-sienna pl-3 text-muted-foreground italic">
            {children}
          </blockquote>
        ),
        img: ({ src, alt }) =>
          streaming ? (
            <div className="grok-md-image animate-pulse bg-secondary/40 h-full min-h-[160px] w-full rounded-[20px]" />
          ) : (
            <MarkdownImage src={src || ""} alt={alt || ""} />
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
    </Streamdown>
  )
}
