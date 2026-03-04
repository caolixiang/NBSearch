import { useEffect, useState } from "react"
import type { AppRuntime } from "./app/contracts"
import { applyAppearanceSettings } from "./app/appearance"
import { getAppRuntime } from "./app/runtime"
import { ChatShell } from "./features/chat/chat-shell"

export function App() {
  const [runtime, setRuntime] = useState<AppRuntime | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAppRuntime().then((resolved) => {
      if (cancelled) {
        return
      }
      setRuntime(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!runtime) {
      return
    }
    applyAppearanceSettings({
      themeMode: runtime.config.themeMode,
      fontSizeMode: runtime.config.fontSizeMode,
    })
  }, [runtime])

  if (!runtime) {
    return null
  }

  return <ChatShell runtime={runtime} />
}
