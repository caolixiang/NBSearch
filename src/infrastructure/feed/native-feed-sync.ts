import { hasTauriRuntime } from "@/app/runtime-info"

export const NATIVE_FEED_SYNC_TICK_EVENT = "nbsearch://feed-sync-tick"

export interface NativeFeedSyncTickPayload {
  reason: "interval" | "window_restored"
  emittedAt: number
}

export async function listenToNativeFeedSyncTick(
  listener: (payload: NativeFeedSyncTickPayload) => void
): Promise<() => void> {
  if (!hasTauriRuntime()) {
    return () => {}
  }
  const { listen } = await import("@tauri-apps/api/event")
  const unlisten = await listen<NativeFeedSyncTickPayload>(NATIVE_FEED_SYNC_TICK_EVENT, (event) => {
    if (event.payload) {
      listener(event.payload)
    }
  })
  return () => {
    unlisten()
  }
}
