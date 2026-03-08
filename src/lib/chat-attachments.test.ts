import { describe, expect, it } from "bun:test"
import {
  buildChatAttachments,
  createImagePreviewDataUrl,
  getAttachmentExtension,
  isImageAttachmentLike,
} from "./chat-attachments"

describe("chat-attachments", () => {
  it("extracts normalized attachment extensions", () => {
    expect(getAttachmentExtension("photo.JPG")).toBe("jpg")
    expect(getAttachmentExtension("archive")).toBe("")
  })

  it("detects image attachments from mime type and extension", () => {
    expect(isImageAttachmentLike({ type: "image/png", name: "image.bin" })).toBe(true)
    expect(isImageAttachmentLike({ type: "", name: "image.webp" })).toBe(true)
    expect(isImageAttachmentLike({ type: "application/pdf", name: "report.pdf" })).toBe(false)
  })

  it("creates bitmap-based preview data urls when decoding succeeds", async () => {
    const originalDocument = globalThis.document
    const originalCreateImageBitmap = globalThis.createImageBitmap

    const drawImageCalls: unknown[][] = []
    const closed: string[] = []
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: () => undefined,
        drawImage: (...args: unknown[]) => {
          drawImageCalls.push(args)
        },
      }),
      toDataURL: () => "data:image/png;base64,bitmap-preview",
    }

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: (tag: string) => {
          if (tag !== "canvas") {
            throw new Error(`unexpected_tag:${tag}`)
          }
          return canvas
        },
      },
    })
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async () => ({
        width: 320,
        height: 180,
        close: () => {
          closed.push("closed")
        },
      }),
    })

    try {
      const preview = await createImagePreviewDataUrl(
        new File(["img"], "cover.png", { type: "image/png" })
      )

      expect(preview).toBe("data:image/png;base64,bitmap-preview")
      expect(drawImageCalls.length).toBe(1)
      expect(closed).toEqual(["closed"])
      expect(canvas.width).toBe(96)
      expect(canvas.height).toBe(96)
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      })
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: originalCreateImageBitmap,
      })
    }
  })

  it("falls back to file reader preview when bitmap decoding fails", async () => {
    const originalDocument = globalThis.document
    const originalCreateImageBitmap = globalThis.createImageBitmap
    const originalFileReader = globalThis.FileReader

    class MockFileReader {
      result: string | ArrayBuffer | null = null
      onload: null | (() => void) = null
      onerror: null | (() => void) = null

      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,fallback-preview`
        this.onload?.()
      }
    }

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => ({
          getContext: () => ({
            clearRect: () => undefined,
            drawImage: () => undefined,
          }),
          toDataURL: () => "data:image/png;base64,unused",
        }),
      },
    })
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async () => {
        throw new Error("decode_failed")
      },
    })
    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: MockFileReader,
    })

    try {
      const preview = await createImagePreviewDataUrl(
        new File(["img"], "cover.png", { type: "image/png" })
      )
      expect(preview).toBe("data:image/png;base64,fallback-preview")
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      })
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: originalCreateImageBitmap,
      })
      Object.defineProperty(globalThis, "FileReader", {
        configurable: true,
        value: originalFileReader,
      })
    }
  })

  it("builds structured attachments in order and keeps image previews", async () => {
    const attachments = await buildChatAttachments(
      [
        new File(["img"], "cover.png", { type: "image/png" }),
        new File(["pdf"], "report.pdf", { type: "application/pdf" }),
        new File(["sheet"], "table.csv", { type: "text/csv" }),
      ],
      {
        previewBuilder: async (file) => `preview:${file.name}`,
      }
    )

    expect(attachments).toEqual([
      {
        name: "cover.png",
        kind: "image",
        extension: "png",
        previewImageUrl: "preview:cover.png",
      },
      {
        name: "report.pdf",
        kind: "file",
        extension: "pdf",
      },
      {
        name: "table.csv",
        kind: "file",
        extension: "csv",
      },
    ])
  })
})
