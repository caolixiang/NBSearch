import { describe, expect, it } from "bun:test"
import { resolveGatewayMediaUrl } from "./grok-chat-service"

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  return Buffer.from(base64 + padding, "base64").toString("utf8")
}

function extractImageToken(url: string): string {
  const marker = "/images/"
  const idx = url.indexOf(marker)
  if (idx < 0) {
    return ""
  }
  return url.slice(idx + marker.length)
}

describe("resolveGatewayMediaUrl", () => {
  const gatewayApiUrl = "http://127.0.0.1:8787/v1/responses"

  it("maps generated relative asset path to /images/p_ token", () => {
    const raw = "users/abc/generated/img-1/image.jpg"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved.startsWith("http://127.0.0.1:8787/images/p_")).toBe(true)

    const token = extractImageToken(resolved)
    expect(token.startsWith("p_")).toBe(true)
    expect(decodeBase64Url(token.slice(2))).toBe("/users/abc/generated/img-1/image.jpg")
  })

  it("maps assets.grok absolute url to /images/u_ token", () => {
    const raw = "https://assets.grok.com/users/u-1/generated/g-1/image.jpg"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved.startsWith("http://127.0.0.1:8787/images/u_")).toBe(true)

    const token = extractImageToken(resolved)
    expect(token.startsWith("u_")).toBe(true)
    expect(decodeBase64Url(token.slice(2))).toBe(raw)
  })

  it("keeps external absolute image url as-is", () => {
    const raw = "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRwzbcIptLxYiHCT_ko5OV2fJxPBAjB7c33oA&s"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved).toBe(raw)
  })

  it("keeps existing gateway /images url", () => {
    const raw = "http://127.0.0.1:8787/images/image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const resolved = resolveGatewayMediaUrl(raw, gatewayApiUrl)
    expect(resolved).toBe(raw)
  })
})
