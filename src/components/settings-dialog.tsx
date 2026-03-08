"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { AppFontSizeMode, AppRuntime, AppThemeMode } from "@/app/contracts"
import {
  loadAppConfig,
  saveAppearanceConfigToToml,
  saveGatewayConfigToToml,
} from "@/app/config"
import { getRuntimeInfo, hasTauriRuntime } from "@/app/runtime-info"
import { checkForAppUpdate, installAppUpdate } from "@/app/updater"
import { cn } from "@/lib/utils"
import { Bell, Database, Eye, EyeOff, Globe, Key, Palette, Shield } from "lucide-react"

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  runtime: AppRuntime
  onGatewayConfigChange: (next: { apiBaseUrl: string; apiKey: string }) => void
  onAppearanceConfigChange: (next: {
    themeMode: AppThemeMode
    fontSizeMode: AppFontSizeMode
  }) => void
}

const tabs = [
  { id: "gateway", label: "网关", icon: Globe },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "notifications", label: "通知", icon: Bell },
  { id: "privacy", label: "隐私与安全", icon: Shield },
  { id: "data", label: "数据管理", icon: Database },
] as const

type TabId = (typeof tabs)[number]["id"]

type ImageCacheStats = {
  rootPath: string
  items: number
  bytes: number
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function SettingsDialog({
  open,
  onOpenChange,
  runtime,
  onGatewayConfigChange,
  onAppearanceConfigChange,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>("gateway")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [themeMode, setThemeMode] = useState<AppThemeMode>("light")
  const [fontSizeMode, setFontSizeMode] = useState<AppFontSizeMode>("default")
  const [showApiKey, setShowApiKey] = useState(false)
  const [gatewayBusy, setGatewayBusy] = useState(false)
  const [gatewayMessage, setGatewayMessage] = useState("")
  const [appearanceMessage, setAppearanceMessage] = useState("")
  const [imageCacheStats, setImageCacheStats] = useState<ImageCacheStats | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [cacheMessage, setCacheMessage] = useState("")
  const [appVersion, setAppVersion] = useState("")
  const [updateEnabled, setUpdateEnabled] = useState<boolean | null>(null)
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState("")
  const [updateBusy, setUpdateBusy] = useState(false)
  const [installBusy, setInstallBusy] = useState(false)
  const [updateMessage, setUpdateMessage] = useState("")
  const appearanceSaveSequenceRef = useRef(0)

  const loadImageCacheStats = useCallback(async () => {
    if (!hasTauriRuntime()) {
      setImageCacheStats(null)
      return
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const stats = await invoke<ImageCacheStats>("get_image_cache_stats")
      setImageCacheStats(stats)
    } catch {
      setImageCacheStats(null)
    }
  }, [])

  const loadUpdaterRuntime = useCallback(async () => {
    if (!hasTauriRuntime()) {
      setAppVersion("")
      setUpdateEnabled(false)
      return
    }
    try {
      const info = await getRuntimeInfo()
      setAppVersion(info.appVersion || "unknown")
    } catch {
      setAppVersion("unknown")
    }
  }, [])

  useEffect(() => {
    if (!open || activeTab !== "data") {
      return
    }
    void loadImageCacheStats()
    void loadUpdaterRuntime()
  }, [activeTab, loadImageCacheStats, loadUpdaterRuntime, open])

  useEffect(() => {
    if (!open) {
      return
    }
    setBaseUrl(runtime.config.apiBaseUrl || "")
    setApiKey(runtime.config.apiKey || "")
    setThemeMode(runtime.config.themeMode)
    setFontSizeMode(runtime.config.fontSizeMode)
    setShowApiKey(false)
    setGatewayMessage("")
    setAppearanceMessage("")
    setUpdateAvailableVersion("")
    setUpdateMessage("")
    setUpdateEnabled(null)
  }, [
    open,
    runtime.config.apiBaseUrl,
    runtime.config.apiKey,
    runtime.config.themeMode,
    runtime.config.fontSizeMode,
  ])

  const clearImageCache = async () => {
    if (!hasTauriRuntime() || cacheBusy) {
      return
    }
    setCacheBusy(true)
    setCacheMessage("")
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const result = await invoke<{ clearedItems: number; clearedBytes: number }>("clear_image_cache")
      setCacheMessage(
        `已清除 ${result.clearedItems} 项缓存（${formatBytes(result.clearedBytes)}）`
      )
      await loadImageCacheStats()
    } catch {
      setCacheMessage("清除图片缓存失败")
    } finally {
      setCacheBusy(false)
    }
  }

  const saveGatewayConfig = async () => {
    if (gatewayBusy) {
      return
    }
    setGatewayBusy(true)
    setGatewayMessage("")

    try {
      const nextBaseUrl = baseUrl.trim()
      const nextApiKey = apiKey.trim()
      if (hasTauriRuntime()) {
        const saved = await saveGatewayConfigToToml({
          apiBaseUrl: nextBaseUrl,
          apiKey: nextApiKey,
        })
        if (!saved) {
          throw new Error("persist_gateway_config_failed")
        }
      }
      const resolved = await loadAppConfig()
      onGatewayConfigChange({
        apiBaseUrl: resolved.apiBaseUrl,
        apiKey: resolved.apiKey,
      })
      setBaseUrl(resolved.apiBaseUrl)
      setApiKey(resolved.apiKey)
    } catch {
      setGatewayMessage("保存失败，请重试")
    } finally {
      setGatewayBusy(false)
    }
  }

  const applyAndPersistAppearance = useCallback(
    async (next: { themeMode: AppThemeMode; fontSizeMode: AppFontSizeMode }) => {
      setThemeMode(next.themeMode)
      setFontSizeMode(next.fontSizeMode)
      onAppearanceConfigChange(next)
      setAppearanceMessage("")
      const sequence = appearanceSaveSequenceRef.current + 1
      appearanceSaveSequenceRef.current = sequence

      try {
        if (hasTauriRuntime()) {
          const saved = await saveAppearanceConfigToToml({
            themeMode: next.themeMode,
            fontSizeMode: next.fontSizeMode,
          })
          if (!saved) {
            throw new Error("persist_appearance_config_failed")
          }
        }
        const resolved = await loadAppConfig()
        if (appearanceSaveSequenceRef.current !== sequence) {
          return
        }
        const resolvedAppearance = {
          themeMode: resolved.themeMode,
          fontSizeMode: resolved.fontSizeMode,
        }
        setThemeMode(resolvedAppearance.themeMode)
        setFontSizeMode(resolvedAppearance.fontSizeMode)
        onAppearanceConfigChange(resolvedAppearance)
      } catch {
        if (appearanceSaveSequenceRef.current !== sequence) {
          return
        }
        setAppearanceMessage("自动保存失败，请重试")
      }
    },
    [onAppearanceConfigChange]
  )

  const handleThemeModeChange = useCallback(
    (nextThemeMode: AppThemeMode) => {
      if (themeMode === nextThemeMode) {
        return
      }
      void applyAndPersistAppearance({
        themeMode: nextThemeMode,
        fontSizeMode,
      })
    },
    [applyAndPersistAppearance, fontSizeMode, themeMode]
  )

  const handleFontSizeModeChange = useCallback(
    (nextFontSizeMode: AppFontSizeMode) => {
      if (fontSizeMode === nextFontSizeMode) {
        return
      }
      void applyAndPersistAppearance({
        themeMode,
        fontSizeMode: nextFontSizeMode,
      })
    },
    [applyAndPersistAppearance, fontSizeMode, themeMode]
  )

  const checkUpdates = useCallback(async () => {
    if (!hasTauriRuntime() || updateBusy || installBusy) {
      return
    }
    setUpdateBusy(true)
    setUpdateMessage("")

    try {
      const result = await checkForAppUpdate()
      if (!result) {
        setUpdateEnabled(false)
        setUpdateAvailableVersion("")
        setUpdateMessage("仅桌面端可用")
        return
      }

      setUpdateEnabled(result.enabled)
      setAppVersion(result.currentVersion || appVersion || "unknown")

      if (!result.enabled) {
        setUpdateAvailableVersion("")
        setUpdateMessage(result.error ? "自动更新配置无效" : "当前构建未启用自动更新")
        return
      }

      if (result.available && result.version) {
        setUpdateAvailableVersion(result.version)
        setUpdateMessage("发现新版本 " + result.version)
        return
      }

      setUpdateAvailableVersion("")
      setUpdateMessage("当前已是最新版本")
    } catch {
      setUpdateMessage("检查更新失败，请稍后重试")
    } finally {
      setUpdateBusy(false)
    }
  }, [appVersion, installBusy, updateBusy])

  const installUpdateNow = useCallback(async () => {
    if (!hasTauriRuntime() || installBusy || updateBusy) {
      return
    }
    setInstallBusy(true)
    setUpdateMessage("")

    try {
      const result = await installAppUpdate()
      if (!result) {
        setUpdateMessage("仅桌面端可用")
        return
      }

      setUpdateEnabled(result.enabled)
      setAppVersion(result.currentVersion || appVersion || "unknown")

      if (!result.enabled) {
        setUpdateMessage(result.error ? "自动更新配置无效" : "当前构建未启用自动更新")
        return
      }

      if (result.installed) {
        setUpdateAvailableVersion("")
        setUpdateMessage("更新包已安装，应用即将重启")
        return
      }

      setUpdateMessage(result.error === "no_update_available" ? "当前没有可安装的更新" : "安装更新失败，请稍后重试")
    } catch {
      setUpdateMessage("安装更新失败，请稍后重试")
    } finally {
      setInstallBusy(false)
    }
  }, [appVersion, installBusy, updateBusy])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">设置</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-[420px]">
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
                      onChange={(event) => setBaseUrl(event.target.value)}
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
                    <div className="relative">
                      <input
                        type={showApiKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder="gw-..."
                        className="w-full rounded-lg border border-input bg-background px-3 py-2 pr-10 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((prev) => !prev)}
                        aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                        className="absolute inset-y-0 right-2 inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      你的 API 密钥将安全存储在本地
                    </p>
                  </div>

                  {gatewayMessage ? (
                    <p className="text-xs text-muted-foreground">{gatewayMessage}</p>
                  ) : null}
                </div>

                <div className="flex justify-end pt-2">
                  <Button
                    size="sm"
                    className="bg-foreground text-background hover:opacity-80"
                    onClick={() => {
                      void saveGatewayConfig()
                    }}
                    disabled={gatewayBusy}
                  >
                    {gatewayBusy ? "保存中..." : "保存"}
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
                      {[
                        { label: "浅色", value: "light" as const },
                        { label: "深色", value: "dark" as const },
                        { label: "跟随系统", value: "system" as const },
                      ].map((theme) => (
                        <button
                          key={theme.value}
                          onClick={() => {
                            handleThemeModeChange(theme.value)
                          }}
                          className={cn(
                            "rounded-lg border px-4 py-2 text-sm transition-colors",
                            themeMode === theme.value
                              ? "border-foreground/15 bg-foreground text-background"
                              : "border-input bg-background text-foreground hover:bg-secondary"
                          )}
                        >
                          {theme.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">字体大小</label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        {
                          label: "小",
                          value: "small" as const,
                          hint: "紧凑",
                          previewClassName: "text-xs",
                        },
                        {
                          label: "默认",
                          value: "default" as const,
                          hint: "平衡",
                          previewClassName: "text-sm",
                        },
                        {
                          label: "大",
                          value: "large" as const,
                          hint: "易读",
                          previewClassName: "text-base",
                        },
                      ].map((size) => (
                        <button
                          key={size.value}
                          onClick={() => {
                            handleFontSizeModeChange(size.value)
                          }}
                          className={cn(
                            "w-40 rounded-xl border px-3 py-2.5 text-left transition-colors",
                            fontSizeMode === size.value
                              ? "border-foreground/15 bg-foreground text-background"
                              : "border-input bg-background text-foreground hover:bg-secondary"
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{size.label}</span>
                            <span
                              className={cn(
                                "font-semibold leading-none",
                                fontSizeMode === size.value ? "text-background/90" : "text-foreground/90",
                                size.previewClassName
                              )}
                            >
                              Aa
                            </span>
                          </div>
                          <p
                            className={cn(
                              "mt-1 text-xs",
                              fontSizeMode === size.value ? "text-background/70" : "text-muted-foreground"
                            )}
                          >
                            {size.hint}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {appearanceMessage ? (
                    <p className="text-xs text-destructive">{appearanceMessage}</p>
                  ) : null}
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
                    <div
                      key={item}
                      className="flex items-center justify-between rounded-lg border border-input p-3"
                    >
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
                    <div
                      key={item}
                      className="flex items-center justify-between rounded-lg border border-input p-3"
                    >
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
                  <div className="rounded-lg border border-input p-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm text-foreground">应用更新</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {hasTauriRuntime()
                            ? appVersion
                              ? "当前版本 " + appVersion + (updateAvailableVersion ? " · 可更新到 " + updateAvailableVersion : "")
                              : "读取版本信息中..."
                            : "仅桌面端可用"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void checkUpdates()
                          }}
                          disabled={!hasTauriRuntime() || updateBusy || installBusy}
                        >
                          {updateBusy ? "检查中..." : "检查更新"}
                        </Button>
                        {updateAvailableVersion ? (
                          <Button
                            size="sm"
                            className="bg-foreground text-background hover:opacity-80"
                            onClick={() => {
                              void installUpdateNow()
                            }}
                            disabled={!hasTauriRuntime() || updateBusy || installBusy}
                          >
                            {installBusy ? "更新中..." : "更新并重启"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {updateMessage ? (
                      <p className="mt-2 text-xs text-muted-foreground">{updateMessage}</p>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-input p-3">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm text-foreground">图片缓存</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {hasTauriRuntime()
                            ? imageCacheStats
                              ? `${imageCacheStats.items} 项 · ${formatBytes(imageCacheStats.bytes)}`
                              : "读取缓存信息中..."
                            : "仅桌面端可用"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={clearImageCache}
                        disabled={!hasTauriRuntime() || cacheBusy}
                      >
                        {cacheBusy ? "清理中..." : "清除图片缓存"}
                      </Button>
                    </div>
                    {cacheMessage ? (
                      <p className="mt-2 text-xs text-muted-foreground">{cacheMessage}</p>
                    ) : null}
                  </div>
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
