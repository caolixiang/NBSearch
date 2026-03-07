import { describe, expect, it } from "bun:test"
import {
  inferGeneratedImageAssetId,
  parseRenewedAssetUrlResponse,
  resolveGatewayMediaUrl,
  shouldRenewCardAssetUrl,
} from "./gateway-media-assets"

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

describe("parseRenewedAssetUrlResponse", () => {
  it("parses direct payload with snake_case keys", () => {
    const parsed = parseRenewedAssetUrlResponse({
      asset_id: "asset_1",
      raw_url: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/a.jpg?X-Amz-Signature=abc",
      url_expires_at: "2026-03-02T10:00:00Z",
    })

    expect(parsed).toEqual({
      assetId: "asset_1",
      rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/a.jpg?X-Amz-Signature=abc",
      urlExpiresAt: new Date("2026-03-02T10:00:00Z").toISOString(),
    })
  })

  it("parses wrapped payload", () => {
    const parsed = parseRenewedAssetUrlResponse({
      result: {
        response: {
          assetId: "asset_2",
          rawUrl: "https://assets.grok.com/users/u-1/generated/asset_2/image.jpg",
          url: "https://bucket.s3.ap-east-1.amazonaws.com/b.jpg?X-Amz-Signature=def",
          urlExpiresAt: "2026-03-02T11:00:00Z",
        },
      },
    })

    expect(parsed?.assetId).toBe("asset_2")
    expect(parsed?.url).toContain("b.jpg")
  })

  it("parses unix timestamp expires field", () => {
    const parsed = parseRenewedAssetUrlResponse({
      asset_id: "asset_3",
      raw_url: "https://assets.grok.com/users/u-1/generated/asset_3/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/c.jpg?X-Amz-Signature=ghi",
      url_expires_at: 1772411111,
    })

    expect(parsed).toEqual({
      assetId: "asset_3",
      rawUrl: "https://assets.grok.com/users/u-1/generated/asset_3/image.jpg",
      url: "https://bucket.s3.ap-east-1.amazonaws.com/c.jpg?X-Amz-Signature=ghi",
      urlExpiresAt: new Date(1772411111 * 1000).toISOString(),
    })
  })

  it("infers expires_at from signed url when field is missing", () => {
    const parsed = parseRenewedAssetUrlResponse({
      asset_id: "asset_4",
      raw_url: "https://assets.grok.com/users/u-1/generated/asset_4/image.jpg",
      url: "https://s3.bitiful.net/grok/assets/image/2026/03/demo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test%2F20260302%2Fs3.bitiful.net%2Fs3%2Faws4_request&X-Amz-Date=20260302T020000Z&X-Amz-Expires=7200&X-Amz-SignedHeaders=host",
    })

    expect(parsed?.assetId).toBe("asset_4")
    expect(parsed?.url).toContain("demo.jpg")
    expect(parsed?.urlExpiresAt).toBe(new Date("2026-03-02T04:00:00Z").toISOString())
  })
})

describe("shouldRenewCardAssetUrl", () => {
  it("requires refresh when url is expired", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "asset_1",
        asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
        url: "https://bucket.s3.amazonaws.com/a.jpg?X-Amz-Signature=abc",
        urlExpiresAt: "2026-03-02T00:00:00Z",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(true)
  })

  it("skips refresh when signed url is still valid", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "asset_1",
        asset_id: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/asset_1/image.jpg",
        url: "https://bucket.s3.amazonaws.com/a.jpg?X-Amz-Signature=abc",
        urlExpiresAt: "2026-03-02T02:30:00Z",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(false)
  })

  it("skips refresh for public url without expires_at", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/a/image.jpg",
        url: "https://cdn.example.com/generated/a.jpg",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(false)
  })

  it("skips refresh for local image proxy url without expires_at", () => {
    const shouldRenew = shouldRenewCardAssetUrl(
      {
        assetId: "image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawUrl: "https://assets.grok.com/users/u-1/generated/a/image.jpg",
        url: "http://127.0.0.1:8787/images/image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      Date.parse("2026-03-02T01:00:00Z")
    )

    expect(shouldRenew).toBe(false)
  })
})

describe("inferGeneratedImageAssetId", () => {
  it("extracts asset id from generated image url", () => {
    const assetId = inferGeneratedImageAssetId(
      "https://assets.grok.com/users/u-1/generated/25da98c5-a40f-426f-86f2-5713538aa1b1/image.jpg"
    )
    expect(assetId).toBe("25da98c5-a40f-426f-86f2-5713538aa1b1")
  })

  it("extracts local image asset id from signed s3 url", () => {
    const assetId = inferGeneratedImageAssetId(
      "https://s3.bitiful.net/grok/assets/image/2026/03/738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23.jpg?X-Amz-Date=20260302T060955Z&X-Amz-Expires=7200"
    )
    expect(assetId).toBe("image_738e5a35d38a72d86a6135d38849ec9099cb48f032894bc1aece65f0c3455c23")
  })
})
