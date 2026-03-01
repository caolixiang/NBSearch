import { hasTauriRuntime } from "@/app/runtime-info"

interface TlsImageFetchResponse {
  status: number
  contentType: string
  finalUrl: string
  body: number[]
  profile: string
}

export async function tauriTlsImageFetch(
  url: string,
  headers?: Record<string, string>
): Promise<Blob | null> {
  if (!hasTauriRuntime()) {
    return null
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const payload = await invoke<TlsImageFetchResponse>("fetch_image_with_tls_profile", {
      url,
      headers,
    })
    if (!payload || !Array.isArray(payload.body) || payload.body.length === 0) {
      return null
    }
    return new Blob([new Uint8Array(payload.body)], {
      type: payload.contentType || "application/octet-stream",
    })
  } catch {
    return null
  }
}

