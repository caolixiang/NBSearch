import { useEffect, useMemo, useState } from "react"
import { getRuntimeInfo, hasTauriRuntime, type RuntimeInfo } from "./app/runtime-info"
import { getAppRuntime } from "./app/runtime"

const initialRuntime: RuntimeInfo = {
  isTauri: false,
  appVersion: "loading",
  platform: "loading",
  appDataDir: "",
  appLogDir: "",
}

export function App() {
  const appRuntime = useMemo(() => getAppRuntime(), [])
  const config = appRuntime.config
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo>(initialRuntime)
  const [storageBackend, setStorageBackend] = useState<"sqlite" | "memory">("memory")
  const [conversationCount, setConversationCount] = useState<number>(0)

  useEffect(() => {
    let mounted = true
    getRuntimeInfo()
      .then((info) => {
        if (mounted) {
          setRuntimeInfo(info)
        }
      })
      .catch(() => {
        if (mounted) {
          setRuntimeInfo({
            isTauri: false,
            appVersion: "unknown",
            platform: "unknown",
            appDataDir: "",
            appLogDir: "",
          })
        }
      })

    appRuntime.services.repository
      .listConversations()
      .then((list) => {
        if (mounted) {
          setConversationCount(list.length)
        }
      })
      .catch(() => {
        if (mounted) {
          setConversationCount(0)
        }
      })

    if (hasTauriRuntime()) {
      setStorageBackend("sqlite")
    } else {
      setStorageBackend("memory")
    }

    return () => {
      mounted = false
    }
  }, [appRuntime])

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <section
        style={{
          width: "min(960px, 96vw)",
          borderRadius: 14,
          border: "1px solid #d9dee5",
          background: "#ffffff",
          padding: 24,
          boxShadow: "0 8px 28px rgba(16, 20, 24, 0.06)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>Chat App Tauri Shell</h1>
        <p style={{ marginTop: 12, lineHeight: 1.6, color: "#39424d" }}>
          Phase 3 baseline is ready. This shell now supports Bun + Vite + Tauri
          and exposes runtime/config placeholders for gateway integration.
        </p>

        <div
          style={{
            marginTop: 18,
            padding: 14,
            borderRadius: 10,
            background: "#f7f9fc",
            border: "1px solid #e7edf6",
            lineHeight: 1.8,
            fontSize: 14,
          }}
        >
          <div>
            <strong>Runtime:</strong> {runtimeInfo.isTauri ? "tauri" : "web"}
          </div>
          <div>
            <strong>App Version:</strong> {runtimeInfo.appVersion}
          </div>
          <div>
            <strong>Platform:</strong> {runtimeInfo.platform}
          </div>
          <div>
            <strong>App Data Dir:</strong> {runtimeInfo.appDataDir || "(not available in web mode)"}
          </div>
          <div>
            <strong>App Log Dir:</strong> {runtimeInfo.appLogDir || "(not available in web mode)"}
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 10,
            background: "#fff8ef",
            border: "1px solid #f3dfbf",
            lineHeight: 1.8,
            fontSize: 14,
          }}
        >
          <div>
            <strong>API Base URL:</strong> {config.apiBaseUrl}
          </div>
          <div>
            <strong>Default Model:</strong> {config.defaultModel}
          </div>
          <div>
            <strong>Voice Enabled:</strong> {String(config.voiceEnabled)}
          </div>
          <div>
            <strong>Voice Service:</strong> gateway `/api/v1/voice/*`
          </div>
          <div>
            <strong>API Key Configured:</strong> {config.apiKey ? "yes" : "no"}
          </div>
          <div>
            <strong>Anthropic Key Configured:</strong> {config.anthropicApiKey ? "yes" : "no"}
          </div>
          <div>
            <strong>Storage Backend:</strong> {storageBackend}
          </div>
          <div>
            <strong>Conversation Count:</strong> {conversationCount}
          </div>
        </div>
      </section>
    </main>
  )
}
