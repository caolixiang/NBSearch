"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
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
            "grid h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-center rounded-xl px-1 transition-colors",
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
            className="w-full min-w-0 px-2 text-left text-sm"
          >
            <span className="block truncate">{resolveConversationLabel(convo)}</span>
          </button>
          {onDelete || (onRename && !isEmptyConversation(convo)) ? (
            <div
              className={cn(
                "ml-1 flex shrink-0 items-center justify-end gap-1 pr-1 transition-opacity",
                hoveredId === convo.id || activeId === convo.id ? "opacity-100" : "pointer-events-none opacity-0"
              )}
            >
              {onRename && !isEmptyConversation(convo) ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    beginRename(convo)
                  }}
                  disabled={disableConversationActions}
                  className="flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
                  className="flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/80 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="删除对话"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
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
            NBSearch
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
      <div className="chat-sidebar-scroll-area flex-1 overflow-y-auto px-3">
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
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        >
          <Settings className="size-4 opacity-50" />
          <span>设置</span>
        </button>
      </div>
    </div>
  )
}
