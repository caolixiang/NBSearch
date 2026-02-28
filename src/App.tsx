import { useMemo } from "react"
import { getAppRuntime } from "./app/runtime"
import { ChatShell } from "./features/chat/chat-shell"

export function App() {
  const runtime = useMemo(() => getAppRuntime(), [])
  return <ChatShell runtime={runtime} />
}
