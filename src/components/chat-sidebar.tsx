"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Plus,
  MessageSquare,
  PanelLeftClose,
  PanelLeft,
  Settings,
  Trash2,
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
  onDelete?: (id: string) => void
  onOpenSettings: () => void
  isCollapsed: boolean
  onToggleCollapse: () => void
}

export function ChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
  isCollapsed,
  onToggleCollapse,
}: ChatSidebarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

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
      <button
        onClick={() => onSelect(convo.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors pr-8",
          activeId === convo.id
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50"
        )}
      >
        <MessageSquare className="size-4 shrink-0 opacity-50" />
        <span className="truncate">{convo.title}</span>
      </button>
      {/* Delete button on hover */}
      {hoveredId === convo.id && onDelete ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete?.(convo.id)
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          aria-label="删除对话"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
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
