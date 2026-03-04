import { useEffect, useState } from "react"
import type { AppRuntime } from "./app/contracts"
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

  if (!runtime) {
    return null
  }

  return <ChatShell runtime={runtime} />
}
