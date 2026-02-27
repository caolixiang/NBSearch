"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Globe, Key, Palette, Bell, Shield, Database } from "lucide-react"

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const tabs = [
  { id: "gateway", label: "网关", icon: Globe },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "notifications", label: "通知", icon: Bell },
  { id: "privacy", label: "隐私与安全", icon: Shield },
  { id: "data", label: "数据管理", icon: Database },
] as const

type TabId = (typeof tabs)[number]["id"]

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>("gateway")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0 overflow-hidden">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">设置</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-[420px]">
          {/* Sidebar tabs */}
          <nav className="w-44 shrink-0 border-r border-border bg-secondary/30 p-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                  activeTab === tab.id
                    ? "bg-background text-foreground font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                )}
              >
                <tab.icon className="size-4" />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 p-6">
            {activeTab === "gateway" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-foreground">网关配置</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    配置 AI 模型的 API 接入地址和密钥
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <Globe className="size-3.5 text-muted-foreground" />
                      Base URL
                    </label>
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring transition-colors"
                    />
                    <p className="text-xs text-muted-foreground">
                      自定义 API 端点地址，留空使用默认网关
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <Key className="size-3.5 text-muted-foreground" />
                      API Key
                    </label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring transition-colors"
                    />
                    <p className="text-xs text-muted-foreground">
                      你的 API 密钥将安全存储在本地
                    </p>
                  </div>


                </div>

                <div className="flex justify-end pt-2">
                  <Button
                    size="sm"
                    className="bg-foreground text-background hover:opacity-80"
                    onClick={() => onOpenChange(false)}
                  >
                    保存
                  </Button>
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-foreground">外观设置</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">自定义界面主题和显示效果</p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">主题</label>
                    <div className="flex gap-2">
                      {["浅色", "深色", "跟随系统"].map((theme) => (
                        <button
                          key={theme}
                          className="rounded-lg border border-input bg-background px-4 py-2 text-sm text-foreground hover:bg-secondary transition-colors"
                        >
                          {theme}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">字体大小</label>
                    <select className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none">
                      <option>小</option>
                      <option>默认</option>
                      <option>大</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">语言</label>
                    <select className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none">
                      <option>中文</option>
                      <option>English</option>
                      <option>日本語</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "notifications" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-foreground">通知设置</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">管理消息和系统通知偏好</p>
                </div>
                <div className="space-y-3">
                  {["桌面通知", "声音提示", "邮件通知"].map((item) => (
                    <div key={item} className="flex items-center justify-between rounded-lg border border-input p-3">
                      <span className="text-sm text-foreground">{item}</span>
                      <div className="h-5 w-9 rounded-full bg-muted" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "privacy" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-foreground">隐私与安全</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">管理数据共享和安全设置</p>
                </div>
                <div className="space-y-3">
                  {["允许模型训练使用对话数据", "保存对话历史", "分享使用数据用于改进"].map((item) => (
                    <div key={item} className="flex items-center justify-between rounded-lg border border-input p-3">
                      <span className="text-sm text-foreground">{item}</span>
                      <div className="h-5 w-9 rounded-full bg-muted" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "data" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-medium text-foreground">数据管理</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">导出或删除你的数据</p>
                </div>
                <div className="space-y-3">
                  <button className="w-full rounded-lg border border-input p-3 text-left text-sm text-foreground hover:bg-secondary transition-colors">
                    导出所有对话
                  </button>
                  <button className="w-full rounded-lg border border-destructive/30 p-3 text-left text-sm text-destructive hover:bg-destructive/5 transition-colors">
                    删除所有对话
                  </button>
                  <button className="w-full rounded-lg border border-destructive/30 p-3 text-left text-sm text-destructive hover:bg-destructive/5 transition-colors">
                    删除账户
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
