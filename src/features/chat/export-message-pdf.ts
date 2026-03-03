import { normalizeAssistantMarkdown } from "@/components/markdown-content"
import type { Root } from "react-dom/client"

const PDF_PAGE_WIDTH_PT = 595.28
const PDF_PAGE_HEIGHT_PT = 841.89
const PDF_PAGE_RATIO = PDF_PAGE_HEIGHT_PT / PDF_PAGE_WIDTH_PT

const MAX_TITLE_LENGTH = 64
const IMAGE_WAIT_TIMEOUT_MS = 12000
const ISOLATED_MARKDOWN_WIDTH = 860

function normalizeConversationTitle(rawTitle: string): string {
  const normalized = rawTitle
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\.+$/g, "")
    .trim()
  if (!normalized) {
    return "新对话"
  }
  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized
  }
  return normalized.slice(0, MAX_TITLE_LENGTH).trim()
}

export function buildConversationPdfFileName(title: string, round: number): string {
  const safeTitle = normalizeConversationTitle(title)
  const safeRound = Number.isFinite(round) && round > 0 ? Math.floor(round) : 1
  return `${safeTitle}-${safeRound}.pdf`
}

function shouldIgnoreCaptureNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) {
    return false
  }
  return node.dataset.pdfExportIgnore === "true"
}

async function waitForElementImages(element: HTMLElement): Promise<void> {
  const images = Array.from(element.querySelectorAll("img"))
  if (images.length === 0) {
    return
  }

  await Promise.all(
    images.map(
      (imageNode) =>
        new Promise<void>((resolve) => {
          const image = imageNode as HTMLImageElement
          if (image.complete && image.naturalWidth > 0) {
            resolve()
            return
          }

          let settled = false
          const done = () => {
            if (settled) {
              return
            }
            settled = true
            window.clearTimeout(timeoutId)
            image.removeEventListener("load", done)
            image.removeEventListener("error", done)
            resolve()
          }

          const timeoutId = window.setTimeout(done, IMAGE_WAIT_TIMEOUT_MS)
          image.addEventListener("load", done)
          image.addEventListener("error", done)
          image.loading = "eager"
        })
    )
  )
}

function splitCanvasIntoPageDataUrls(canvas: HTMLCanvasElement): string[] {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return []
  }

  const pageHeightPx = Math.max(1, Math.floor(canvas.width * PDF_PAGE_RATIO))
  const pageDataUrls: string[] = []

  for (let y = 0; y < canvas.height; y += pageHeightPx) {
    const sliceHeight = Math.min(pageHeightPx, canvas.height - y)
    const pageCanvas = document.createElement("canvas")
    pageCanvas.width = canvas.width
    pageCanvas.height = sliceHeight
    const context = pageCanvas.getContext("2d")
    if (!context) {
      continue
    }

    context.fillStyle = "#FFFFFF"
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    context.drawImage(canvas, 0, y, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
    pageDataUrls.push(pageCanvas.toDataURL("image/jpeg", 0.92))
  }

  return pageDataUrls
}

async function renderIsolatedMarkdownPageImages(content: string): Promise<string[]> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new Error("pdf_dom_capture_unavailable")
  }

  const normalizedContent = normalizeAssistantMarkdown(content || "").trim()
  if (!normalizedContent) {
    throw new Error("pdf_export_empty_content")
  }

  const host = document.createElement("div")
  host.style.position = "fixed"
  host.style.left = "0"
  host.style.top = "0"
  host.style.zIndex = "-1"
  host.style.pointerEvents = "none"
  host.style.background = "#FFFFFF"
  host.style.color = "#2D2B28"
  host.style.colorScheme = "light"
  host.style.width = `${ISOLATED_MARKDOWN_WIDTH}px`
  host.style.padding = "24px 26px"
  host.style.borderRadius = "20px"
  host.style.boxSizing = "border-box"
  host.style.overflow = "hidden"

  const mount = document.createElement("div")
  host.appendChild(mount)
  document.body.appendChild(host)

  let reactRoot: Root | null = null
  try {
    const [{ createElement }, { createRoot }, markdownBodyModule, htmlToImageModule] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("@/components/markdown-content/markdown-body"),
      import("html-to-image"),
    ])
    const MarkdownBody = markdownBodyModule.MarkdownBody

    reactRoot = createRoot(mount)
    reactRoot.render(createElement(MarkdownBody, { content: normalizedContent, streaming: false }))

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })

    await waitForElementImages(host)

    const scale = Math.max(2, Math.min(window.devicePixelRatio || 1, 3))
    const canvas = await htmlToImageModule.toCanvas(host, {
      pixelRatio: scale,
      backgroundColor: "#FFFFFF",
      cacheBust: true,
      skipAutoScale: true,
      style: {
        backgroundColor: "#FFFFFF",
        color: "#2D2B28",
      },
      filter: (node) => !shouldIgnoreCaptureNode(node),
    })

    const pageImages = splitCanvasIntoPageDataUrls(canvas)
    if (pageImages.length === 0) {
      throw new Error("pdf_export_capture_empty")
    }

    return pageImages
  } finally {
    if (reactRoot) {
      reactRoot.unmount()
    }
    host.remove()
  }
}

async function buildPdfFromPageImages(pageImages: string[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib")
  const pdf = await PDFDocument.create()

  for (const imageDataUrl of pageImages) {
    const image = await pdf.embedJpg(imageDataUrl)
    const page = pdf.addPage([PDF_PAGE_WIDTH_PT, PDF_PAGE_HEIGHT_PT])
    const renderedHeight = (image.height / image.width) * PDF_PAGE_WIDTH_PT
    const drawHeight = Math.min(PDF_PAGE_HEIGHT_PT, renderedHeight)
    page.drawImage(image, {
      x: 0,
      y: PDF_PAGE_HEIGHT_PT - drawHeight,
      width: PDF_PAGE_WIDTH_PT,
      height: drawHeight,
    })
  }

  return pdf.save()
}

export async function buildMessagePdfBytes(params: {
  title: string
  round: number
  content: string
  element?: HTMLElement | null
}): Promise<Uint8Array> {
  const pageImages = await renderIsolatedMarkdownPageImages(params.content)
  return buildPdfFromPageImages(pageImages)
}
