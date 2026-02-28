"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Plus,
  PanelLeftClose,
  PanelLeft,
  Settings,
  PenLine,
  Trash2,
  Check,
  X,
} from "lucide-react"
import { GrokAvatar } from "./claude-logo"
import { cn } from "@/lib/utils"

interface Conversation {
  id: string
  title: string
  lastMessage?: string
  updatedAt: Date
}

interface ChatSidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename?: (id: string, title: string) => void
  onDelete?: (id: string) => void
  onOpenSettings: () => void
  disableConversationActions?: boolean
  isCollapsed: boolean
  onToggleCollapse: () => void
}

export function ChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
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

  const beginRename = (conversation: Conversation) => {
    if (disableConversationActions || !onRename) {
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

  const beginDeleteConfirm = (conversationId: string) => {
    if (disableConversationActions || !onDelete) {
      return
    }
    setEditingId(null)
    setEditingTitle("")
    setConfirmingDeleteId(conversationId)
  }

  const today = new Date()
  const todayConvos = conversations.filter(
    (c) => c.updatedAt.toDateString() === today.toDateString()
  )
  const olderConvos = conversations.filter(
    (c) => c.updatedAt.toDateString() !== today.toDateString()
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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNew}
          className="text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <Plus className="size-4" />
        </Button>
      </div>
    )
  }

  const renderConvoItem = (convo: Conversation) => (
    <div
      key={convo.id}
      className="group relative"
      onMouseEnter={() => setHoveredId(convo.id)}
      onMouseLeave={() => setHoveredId(null)}
    >
      {editingId === convo.id ? (
        <div className="flex items-center gap-2 rounded-xl bg-sidebar-accent px-3 py-2 text-sidebar-accent-foreground">
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
            className="min-w-0 flex-1 bg-transparent text-base outline-none"
          />
          <button
            onClick={() => resetModes()}
            className="flex size-9 items-center justify-center rounded-xl text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground"
            aria-label="取消重命名"
          >
            <X className="size-5" />
          </button>
          <button
            onClick={() => confirmRename(convo.id)}
            className="flex size-9 items-center justify-center rounded-xl text-sidebar-foreground transition-colors hover:bg-sidebar-accent/80"
            aria-label="确认重命名"
          >
            <Check className="size-5" />
          </button>
        </div>
      ) : confirmingDeleteId === convo.id ? (
        <div className="flex items-center gap-2 rounded-xl bg-sidebar-accent px-3 py-2 text-sidebar-accent-foreground">
          <span className="min-w-0 flex-1 truncate text-base">删除“{convo.title}”?</span>
          <button
            onClick={() => resetModes()}
            className="flex size-9 items-center justify-center rounded-xl text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground"
            aria-label="取消删除"
          >
            <X className="size-5" />
          </button>
          <button
            onClick={() => {
              onDelete?.(convo.id)
              resetModes()
            }}
            className="flex size-9 items-center justify-center rounded-xl text-destructive transition-colors hover:bg-destructive/10"
            aria-label="确认删除"
          >
            <Check className="size-5" />
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={() => {
              resetModes()
              onSelect(convo.id)
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors pr-24",
              activeId === convo.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/50"
            )}
          >
            <span className="truncate text-base">{convo.title}</span>
          </button>
          {onDelete || onRename ? (
            <div
              className={cn(
                "absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-xl bg-sidebar-accent/90 px-1 py-0.5 transition-opacity",
                hoveredId === convo.id || activeId === convo.id ? "opacity-100" : "opacity-0 pointer-events-none"
              )}
            >
              {onRename ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    beginRename(convo)
                  }}
                  disabled={disableConversationActions}
                  className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="重命名对话"
                >
                  <PenLine className="size-4" />
                </button>
              ) : null}
              {onDelete ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    beginDeleteConfirm(convo.id)
                  }}
                  disabled={disableConversationActions}
                  className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground/80 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="删除对话"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2">
          <GrokAvatar size="sm" />
          <span className="text-sm font-semibold text-sidebar-foreground">
            Grok
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNew}
            className="text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <Plus className="size-4" />
          </Button>
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
      <ScrollArea className="flex-1 px-2">
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
      </ScrollArea>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <Settings className="size-4 opacity-50" />
          <span>设置</span>
        </button>
      </div>
    </div>
  )
}
