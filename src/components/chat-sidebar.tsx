"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  PanelLeftClose,
  PanelLeft,
  Settings,
  Star,
  PenLine,
  Trash2,
  Check,
  X,
  RadioTower,
} from "lucide-react"
import { GrokLottieIcon, HoverAnimationProvider } from "./grok-lottie"
import { cn } from "@/lib/utils"

interface Conversation {
  id: string
  title: string
  starred: boolean
  lastMessage?: string
  updatedAt: Date
}

interface ChatSidebarProps {
  feedItems?: Array<{
    id: string
    title: string
    description?: string
  }>
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onSelectFeed?: (id: string) => void
  onNew: () => void
  onRename?: (id: string, title: string) => void
  onToggleStar?: (id: string, starred: boolean) => void
  onDelete?: (id: string) => void
  onOpenSettings: () => void
  disableConversationActions?: boolean
  isCollapsed: boolean
  onToggleCollapse: () => void
}

function NewConversationButton({
  onNew,
}: {
  onNew: () => void
}) {
  const [isHoveringNew, setIsHoveringNew] = useState(false)

  return (
    <HoverAnimationProvider value={{ isHovering: isHoveringNew }}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onNew}
        onMouseEnter={() => setIsHoveringNew(true)}
        onMouseLeave={() => setIsHoveringNew(false)}
        className="text-sidebar-foreground hover:bg-sidebar-accent"
      >
        <div data-sidebar="icon" className="size-6 flex items-center justify-center shrink-0 transition-transform">
          <GrokLottieIcon
            name="square_pen"
            size={18}
            renderer="svg"
            className="[&>svg_*]:fill-sidebar-foreground [&>svg_*]:stroke-sidebar-foreground"
          />
        </div>
        <span className="sr-only">新建对话</span>
      </Button>
    </HoverAnimationProvider>
  )
}

export function ChatSidebar({
  feedItems = [],
  conversations,
  activeId,
  onSelect,
  onSelectFeed,
  onNew,
  onRename,
  onToggleStar,
  onDelete,
  onOpenSettings,
  disableConversationActions = false,
  isCollapsed,
  onToggleCollapse,
}: ChatSidebarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  const resetModes = () => {
    setEditingId(null)
    setEditingTitle("")
    setConfirmingDeleteId(null)
  }

  const isEmptyConversation = (conversation: Conversation) =>
    conversation.title.trim().length === 0
  const resolveConversationLabel = (conversation: Conversation) =>
    conversation.title.trim() || "新对话"

  const beginRename = (conversation: Conversation) => {
    if (disableConversationActions || !onRename || isEmptyConversation(conversation)) {
      return
    }
    setConfirmingDeleteId(null)
    setEditingId(conversation.id)
    setEditingTitle(conversation.title)
  }

  const confirmRename = (conversationId: string) => {
    const nextTitle = editingTitle.trim()
    if (!nextTitle) {
      resetModes()
      return
    }
    onRename?.(conversationId, nextTitle)
    resetModes()
  }

  const beginDeleteConfirm = (conversation: Conversation) => {
    if (disableConversationActions || !onDelete) {
      return
    }
    if (isEmptyConversation(conversation)) {
      onDelete(conversation.id)
      resetModes()
      return
    }
    setEditingId(null)
    setEditingTitle("")
    setConfirmingDeleteId(conversation.id)
  }

  const today = new Date()
  const starredConvos = conversations.filter((c) => c.starred)
  const todayConvos = conversations.filter(
    (c) => !c.starred && c.updatedAt.toDateString() === today.toDateString()
  )
  const olderConvos = conversations.filter(
    (c) => !c.starred && c.updatedAt.toDateString() !== today.toDateString()
  )

  if (isCollapsed) {
    return (
      <div className="flex h-full w-14 flex-col items-center border-r border-border bg-sidebar py-3 gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapse}
          className="text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <PanelLeft className="size-4" />
        </Button>
        <NewConversationButton onNew={onNew} />
        {feedItems.length > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSelectFeed?.(feedItems[0]!.id)}
            className={cn(
              "text-sidebar-foreground hover:bg-sidebar-accent",
              activeId === feedItems[0]!.id ? "bg-sidebar-accent" : ""
            )}
          >
            <RadioTower className="size-4" />
          </Button>
        ) : null}
      </div>
    )
  }

  const renderFeedItem = (item: { id: string; title: string; description?: string }) => (
    <button
      key={item.id}
      type="button"
      onClick={() => onSelectFeed?.(item.id)}
      className={cn(
        "flex h-auto w-full items-start gap-2 rounded-xl px-2 py-2 text-left transition-colors",
        activeId === item.id
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50"
      )}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-sidebar-border/70 bg-sidebar/80">
        <RadioTower className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        {item.description ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.description}</span>
        ) : null}
      </span>
    </button>
  )

  const renderConvoItem = (convo: Conversation) => {
    const canToggleStar = Boolean(onToggleStar && !isEmptyConversation(convo))
    const shouldShowFullActions = hoveredId === convo.id
    const shouldShowStarButton = canToggleStar && (shouldShowFullActions || convo.starred)
    const canShowTrailingActions = canToggleStar || Boolean(onDelete || (onRename && !isEmptyConversation(convo)))

    return (
      <div
        key={convo.id}
        className="group relative"
        onMouseEnter={() => setHoveredId(convo.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        {editingId === convo.id ? (
          <div className="grid h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center rounded-xl bg-sidebar-accent px-2 text-sidebar-accent-foreground">
            <input
              value={editingTitle}
              onChange={(event) => setEditingTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  confirmRename(convo.id)
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  resetModes()
                }
              }}
              autoFocus
              className="min-w-0 w-full bg-transparent px-1 text-sm leading-none outline-none"
            />
            <div className="ml-1 flex shrink-0 items-center gap-1">
              <button
                onClick={() => resetModes()}
                className="shrink-0 flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground"
                aria-label="取消重命名"
              >
                <X className="size-4" />
              </button>
              <button
                onClick={() => confirmRename(convo.id)}
                className="shrink-0 flex size-7 items-center justify-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/80"
                aria-label="确认重命名"
              >
                <Check className="size-4" />
              </button>
            </div>
          </div>
        ) : confirmingDeleteId === convo.id ? (
          <div className="grid h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center rounded-xl bg-sidebar-accent px-2 text-sidebar-accent-foreground">
            <span className="block min-w-0 truncate px-1 text-sm">删除“{convo.title}”?</span>
            <div className="ml-1 flex shrink-0 items-center gap-1">
              <button
                onClick={() => resetModes()}
                className="shrink-0 flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground"
                aria-label="取消删除"
              >
                <X className="size-4" />
              </button>
              <button
                onClick={() => {
                  onDelete?.(convo.id)
                  resetModes()
                }}
                className="shrink-0 flex size-7 items-center justify-center rounded-lg text-destructive transition-colors hover:bg-destructive/10"
                aria-label="确认删除"
              >
                <Check className="size-4" />
              </button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "relative h-10 w-full rounded-xl px-1 transition-colors",
              activeId === convo.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <button
              onClick={() => {
                resetModes()
                onSelect(convo.id)
              }}
              className={cn(
                "h-full w-full min-w-0 text-left text-sm transition-[padding-right] duration-150",
                shouldShowFullActions ? "px-2 pr-[6.25rem]" : shouldShowStarButton ? "px-2 pr-[2.5rem]" : "px-2 pr-2"
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="block truncate">{resolveConversationLabel(convo)}</span>
              </span>
            </button>
            {canShowTrailingActions ? (
              <div className="absolute inset-y-0 right-1 flex items-center justify-end gap-0.5">
                <div
                  className={cn(
                    "flex items-center justify-end gap-0.5 transition-opacity duration-150",
                    shouldShowFullActions ? "opacity-100" : "pointer-events-none opacity-0"
                  )}
                >
                  {onRename && !isEmptyConversation(convo) ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        beginRename(convo)
                      }}
                      disabled={disableConversationActions}
                      className="flex size-[26px] items-center justify-center rounded-lg border border-transparent text-sidebar-foreground/75 transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:border-sidebar-border/70 hover:bg-sidebar/90 hover:text-sidebar-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="重命名对话"
                    >
                      <PenLine className="size-3.5" />
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        beginDeleteConfirm(convo)
                      }}
                      disabled={disableConversationActions}
                      className="flex size-[26px] items-center justify-center rounded-lg border border-transparent text-sidebar-foreground/75 transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-destructive/15 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/30 disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="删除对话"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                {canToggleStar ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleStar?.(convo.id, !convo.starred)
                    }}
                    disabled={disableConversationActions}
                    className={cn(
                      "flex size-[26px] items-center justify-center rounded-lg border transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring disabled:cursor-not-allowed disabled:opacity-40",
                      convo.starred
                        ? "border-sidebar-border/70 bg-sidebar/90 text-yellow-500 opacity-100 hover:text-yellow-500 dark:text-yellow-400 dark:hover:text-yellow-400"
                        : "border-transparent text-sidebar-foreground/65 hover:border-sidebar-border/70 hover:bg-sidebar/90 hover:text-yellow-500 dark:hover:text-yellow-400",
                      shouldShowStarButton ? "opacity-100" : "pointer-events-none opacity-0"
                    )}
                    aria-label={convo.starred ? "取消星标" : "星标对话"}
                  >
                    <Star className={cn("size-3.5", convo.starred ? "fill-current" : "")} />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full w-72 flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-end px-3 py-3">
        <div className="flex items-center gap-1">
          <NewConversationButton onNew={onNew} />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleCollapse}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>
      </div>

      {/* Conversations list */}
      <div className="chat-sidebar-scroll-area flex-1 overflow-y-auto px-3">
        {feedItems.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              订阅
            </p>
            {feedItems.map(renderFeedItem)}
          </div>
        )}
        {starredConvos.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              星标
            </p>
            {starredConvos.map(renderConvoItem)}
          </div>
        )}
        {todayConvos.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              今天
            </p>
            {todayConvos.map(renderConvoItem)}
          </div>
        )}
        {olderConvos.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              更早
            </p>
            {olderConvos.map(renderConvoItem)}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-2 text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
        >
          <Settings className="size-4 opacity-60" />
          <span className="text-[1.05rem] leading-none font-medium tracking-[-0.01em]">设置</span>
        </button>
      </div>
    </div>
  )
}
