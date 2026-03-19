import { runtimeFetch } from "@/infrastructure/http/runtime-fetch"

const JINA_READER_POLYMARKET_URL = "https://r.jina.ai/http://x.com/Polymarket"
const REQUEST_TIMEOUT_MS = 30_000

export interface JinaReaderClient {
  fetchPolymarketTimeline(signal?: AbortSignal): Promise<string>
}

export class RuntimeJinaReaderClient implements JinaReaderClient {
  async fetchPolymarketTimeline(signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener("abort", forwardAbort, { once: true })
    try {
      const response = await runtimeFetch(JINA_READER_POLYMARKET_URL, {
        method: "GET",
        headers: {
          "x-no-cache": "true",
          Accept: "text/plain",
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(text.trim() || `Jina request failed with ${response.status}`)
      }
      return await response.text()
    } finally {
      globalThis.clearTimeout(timeout)
      signal?.removeEventListener("abort", forwardAbort)
    }
  }
}
