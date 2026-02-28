import { hasTauriRuntime } from "../../app/runtime-info"

let tauriFetchPromise: Promise<typeof fetch | null> | null = null

export function createRuntimeFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!hasTauriRuntime()) {
      return baseFetch(input, init)
    }

    if (!tauriFetchPromise) {
      tauriFetchPromise = import("@tauri-apps/plugin-http")
        .then((module) => module.fetch as typeof fetch)
        .catch(() => null)
    }

    const tauriFetch = await tauriFetchPromise
    if (!tauriFetch) {
      return baseFetch(input, init)
    }

    return tauriFetch(input, init)
  }

  return wrapped as unknown as typeof fetch
}

export const runtimeFetch = createRuntimeFetch(fetch)
