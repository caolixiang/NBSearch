import type { ChatCardAttachmentPayload } from "../../domain/chat/types"

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function isGrokAssetHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  if (!host) {
    return false
  }
  return host === "assets.grok.com" || host === "grok.com" || host.endsWith(".grok.com") || host.endsWith(".x.ai")
}

function toEncodedImagePathToken(raw: string): string {
  const value = raw.trim()
  if (!value) {
    return ""
  }
  if (/^(?:u_|p_)[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9]+)?$/.test(value)) {
    return value
  }
  if (/^(?:image|video)_[0-9a-f]{64}$/i.test(value)) {
    return value
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      if (!isGrokAssetHost(parsed.hostname)) {
        return ""
      }
      return `u_${toBase64Url(parsed.toString())}`
    } catch {
      return ""
    }
  }

  let normalizedPath = value
  if (!normalizedPath.startsWith("/")) {
    normalizedPath = `/${normalizedPath}`
  }
  return `p_${toBase64Url(normalizedPath)}`
}

export function resolveGatewayMediaUrl(rawUrl: string, apiUrl: string): string {
  const url = rawUrl.trim()
  if (!url) {
    return ""
  }
  if (/^(?:data:|blob:)/i.test(url)) {
    return url
  }
  try {
    const gateway = new URL(apiUrl)
    if (url.startsWith("//")) {
      const absolute = `${gateway.protocol}${url}`
      const encoded = toEncodedImagePathToken(absolute)
      if (encoded) {
        return new URL(`/images/${encoded}`, gateway.origin).toString()
      }
      return absolute
    }
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url)
      if (parsed.origin === gateway.origin && parsed.pathname.startsWith("/images/")) {
        return parsed.toString()
      }
      if (parsed.origin === gateway.origin && parsed.pathname.startsWith("/users/")) {
        const encoded = toEncodedImagePathToken(parsed.pathname)
        if (encoded) {
          return new URL(`/images/${encoded}`, gateway.origin).toString()
        }
      }
      const encoded = toEncodedImagePathToken(parsed.toString())
      if (encoded) {
        return new URL(`/images/${encoded}`, gateway.origin).toString()
      }
      return parsed.toString()
    }
    if (url.startsWith("/images/")) {
      return new URL(url, gateway.origin).toString()
    }

    const shouldProxyAsAsset =
      /^(?:u_|p_)[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9]+)?$/.test(url) ||
      /^(?:image|video)_[0-9a-f]{64}$/i.test(url) ||
      /^\/?users\//i.test(url)
    if (shouldProxyAsAsset) {
      const encoded = toEncodedImagePathToken(url)
      if (encoded) {
        return new URL(`/images/${encoded}`, gateway.origin).toString()
      }
    }
    return new URL(`/${url.replace(/^\/+/, "")}`, gateway.origin).toString()
  } catch {
    return url
  }
}

export function normalizeCardAttachmentUrls(card: ChatCardAttachmentPayload, apiUrl: string): ChatCardAttachmentPayload {
  const normalizedUrl = card.url ? resolveGatewayMediaUrl(card.url, apiUrl) : card.url
  const normalizedImage = card.image
    ? {
        ...card.image,
        original: card.image.original ? resolveGatewayMediaUrl(card.image.original, apiUrl) : card.image.original,
        thumbnail: card.image.thumbnail
          ? resolveGatewayMediaUrl(card.image.thumbnail, apiUrl)
          : card.image.thumbnail,
      }
    : undefined

  return {
    ...card,
    url: normalizedUrl,
    image: normalizedImage,
  }
}
