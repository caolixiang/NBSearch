import { useMemo } from "react"
import { getAppRuntime } from "./app/runtime"
import { LegacyChatShell } from "./features/chat/legacy-chat-shell"

export function App() {
  const runtime = useMemo(() => getAppRuntime(), [])
  return <LegacyChatShell runtime={runtime} />
}
