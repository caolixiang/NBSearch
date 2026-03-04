"use client"

import { useMemo } from "react"
import type { ChatDeepSearchResearch, ChatReasoningEventDetail } from "@/domain/chat/types"
import { extractAssistantToolMeta, expandGrokRenderTags, collectCardsFromReasoningEvents } from "./markdown-normalize"
import { parseThinkSections } from "./think-parser"
import { StructuredReasoningPanel } from "./structured-reasoning-panel"
import { ThinkBlock } from "./think-block"
import { MarkdownBody } from "./markdown-body"

// Re-export public API used by tests and other consumers
export { expandGrokRenderTags, normalizeAssistantMarkdown } from "./markdown-normalize"
export { parseThinkSections } from "./think-parser"

export function MarkdownContent({
  content,
  streaming = false,
  reasoningEvents = [],
  reasoningActive = false,
  reasoningDurationSeconds = 0,
  research,
  messageId,
}: {
  content: string
  streaming?: boolean
  reasoningEvents?: ChatReasoningEventDetail[]
  reasoningActive?: boolean
  reasoningDurationSeconds?: number
  research?: ChatDeepSearchResearch
  messageId?: string
}) {
  const parsed = useMemo(() => extractAssistantToolMeta(content), [content])
  const liveCards = useMemo(() => collectCardsFromReasoningEvents(reasoningEvents), [reasoningEvents])
  const mergedCards = useMemo(
    () => ({
      ...parsed.meta.cards,
      ...liveCards,
    }),
    [liveCards, parsed.meta.cards]
  )
  const expandedContent = useMemo(
    () => expandGrokRenderTags(parsed.content, mergedCards),
    [mergedCards, parsed.content]
  )



  const hasStructuredReasoning =
    reasoningEvents.length > 0 ||
    reasoningDurationSeconds > 0 ||
    (Array.isArray(research?.details) && research.details.length > 0)
  const shouldShowStructuredReasoning = hasStructuredReasoning
  const shouldRenderLegacyThink = !hasStructuredReasoning
  const sections = useMemo(
    () =>
      parseThinkSections(expandedContent, {
        treatUnclosedThinkAsThinking: streaming,
      }),
    [expandedContent, streaming]
  )
  const visibleSections = useMemo(
    () =>
      sections.filter((section) => {
        if (section.type === "text") {
          return true
        }
        return shouldRenderLegacyThink
      }),
    [sections, shouldRenderLegacyThink]
  )

  if (!shouldShowStructuredReasoning && visibleSections.length === 0) {
    return null
  }

  return (
    <div className="space-y-1 text-foreground">
      {shouldShowStructuredReasoning ? (
        <StructuredReasoningPanel
          messageId={messageId}
          events={reasoningEvents}
          isThinking={reasoningActive}
          isStreaming={streaming}
          durationSeconds={reasoningDurationSeconds}
          deepSearchDetails={research?.details}
        />
      ) : null}
      {streaming && !content.trim() && !shouldShowStructuredReasoning ? (
        <div className="flex items-center gap-1.5 py-3 pl-1">
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:0ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:300ms]" />
        </div>
      ) : null}
      {visibleSections.map((section, index) => {
        if (section.type === "think") {
          return (
            <ThinkBlock
              key={`think-${index}`}
              content={section.value}
              open={section.open}
              thinking={section.thinking}
              toolMeta={{
                webSearch: parsed.meta.webSearch,
                cards: mergedCards,
              }}
            />
          )
        }
        return <MarkdownBody key={`text-${index}`} content={section.value} streaming={streaming} />
      })}
    </div>
  )
}
