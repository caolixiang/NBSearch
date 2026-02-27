import { useEffect, useMemo, useState } from "react"
import { getRuntimeInfo, hasTauriRuntime, type RuntimeInfo } from "./app/runtime-info"
import { getAppRuntime } from "./app/runtime"
import { ChatShell } from "./features/chat/chat-shell"

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
        flexDirection: "column",
        justifyContent: "center",
        gap: 10,
        padding: 10,
      }}
    >
      <div
        style={{
          width: "min(1240px, 96vw)",
          border: "1px solid #d9dee5",
          borderRadius: 10,
          background: "#ffffff",
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          fontSize: 12,
          color: "#5d6f86",
        }}
      >
        <span>
          runtime={runtimeInfo.isTauri ? "tauri" : "web"} | app={runtimeInfo.appVersion} | platform=
          {runtimeInfo.platform}
        </span>
        <span>
          storage={storageBackend} | conversations={conversationCount} | model={config.defaultModel}
        </span>
      </div>

      <ChatShell runtime={appRuntime} />
    </main>
  )
}
