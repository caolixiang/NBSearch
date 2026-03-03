import { normalizeAssistantMarkdown } from "@/components/markdown-content"

const PDF_PAGE_WIDTH_PT = 595.28
const PDF_PAGE_HEIGHT_PT = 841.89
const PDF_PAGE_RATIO = PDF_PAGE_HEIGHT_PT / PDF_PAGE_WIDTH_PT

const PAGE_RASTER_WIDTH = 1240
const PAGE_RASTER_HEIGHT = 1754
const PAGE_PADDING_X = 72
const PAGE_PADDING_TOP = 96
const PAGE_PADDING_BOTTOM = 88
const PAGE_FONT_SIZE = 28
const PAGE_LINE_HEIGHT = 42
const MAX_TITLE_LENGTH = 64
const IMAGE_WAIT_TIMEOUT_MS = 12000

const EXPORT_THEME_VARS: Record<string, string> = {
  "--background": "#FFFFFF",
  "--card": "#FFFFFF",
  "--popover": "#FFFFFF",
  "--foreground": "#2D2B28",
  "--card-foreground": "#2D2B28",
  "--popover-foreground": "#2D2B28",
  "--secondary": "#ECE7DE",
  "--secondary-foreground": "#2D2B28",
  "--muted-foreground": "#8C877D",
  "--accent-foreground": "#2D2B28",
}

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

function wrapTextLine(
  context: CanvasRenderingContext2D,
  rawLine: string,
  maxWidth: number
): string[] {
  const line = rawLine.replace(/\t/g, "    ")
  if (!line) {
    return [""]
  }

  const wrapped: string[] = []
  let current = ""
  for (const char of line) {
    const candidate = `${current}${char}`
    if (current.length === 0 || context.measureText(candidate).width <= maxWidth) {
      current = candidate
      continue
    }
    wrapped.push(current.trimEnd())
    current = char === " " ? "" : char
  }
  if (current.length > 0) {
    wrapped.push(current.trimEnd())
  }
  if (wrapped.length === 0) {
    wrapped.push("")
  }
  return wrapped
}

function buildRenderableLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const rawLines = normalized.split("\n")
  if (rawLines.length === 0) {
    return [""]
  }
  return rawLines
}

function renderPageImageDataUrlsFromLines(lines: string[]): string[] {
  if (typeof document === "undefined") {
    throw new Error("pdf_render_unavailable")
  }

  const measureCanvas = document.createElement("canvas")
  const measureContext = measureCanvas.getContext("2d")
  if (!measureContext) {
    throw new Error("pdf_measure_context_unavailable")
  }
  measureContext.font =
    `${PAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif`

  const maxTextWidth = PAGE_RASTER_WIDTH - PAGE_PADDING_X * 2
  const wrappedLines: string[] = []
  for (const rawLine of lines) {
    wrappedLines.push(...wrapTextLine(measureContext, rawLine, maxTextWidth))
  }
  if (wrappedLines.length === 0) {
    wrappedLines.push("")
  }

  const linesPerPage = Math.max(
    1,
    Math.floor((PAGE_RASTER_HEIGHT - PAGE_PADDING_TOP - PAGE_PADDING_BOTTOM) / PAGE_LINE_HEIGHT)
  )
  const pageDataUrls: string[] = []

  for (let pageStart = 0; pageStart < wrappedLines.length; pageStart += linesPerPage) {
    const pageLines = wrappedLines.slice(pageStart, pageStart + linesPerPage)
    const canvas = document.createElement("canvas")
    canvas.width = PAGE_RASTER_WIDTH
    canvas.height = PAGE_RASTER_HEIGHT
    const context = canvas.getContext("2d")
    if (!context) {
      throw new Error("pdf_page_context_unavailable")
    }

    context.fillStyle = "#FFFFFF"
    context.fillRect(0, 0, PAGE_RASTER_WIDTH, PAGE_RASTER_HEIGHT)
    context.fillStyle = "#111111"
    context.textBaseline = "top"
    context.font =
      `${PAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif`

    let cursorY = PAGE_PADDING_TOP
    for (const line of pageLines) {
      context.fillText(line, PAGE_PADDING_X, cursorY)
      cursorY += PAGE_LINE_HEIGHT
    }

    pageDataUrls.push(canvas.toDataURL("image/jpeg", 0.92))
  }

  return pageDataUrls
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

function isCanvasMostlyUniform(canvas: HTMLCanvasElement): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return true
  }

  const probe = document.createElement("canvas")
  probe.width = 32
  probe.height = 32
  const context = probe.getContext("2d")
  if (!context) {
    return false
  }
  context.drawImage(canvas, 0, 0, probe.width, probe.height)
  const { data } = context.getImageData(0, 0, probe.width, probe.height)
  if (!data || data.length === 0) {
    return true
  }

  let minLuma = 255
  let maxLuma = 0
  let minAlpha = 255
  let maxAlpha = 0

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const a = data[index + 3]
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
    if (luma < minLuma) minLuma = luma
    if (luma > maxLuma) maxLuma = luma
    if (a < minAlpha) minAlpha = a
    if (a > maxAlpha) maxAlpha = a
  }

  const lumaRange = maxLuma - minLuma
  const alphaRange = maxAlpha - minAlpha
  return lumaRange <= 12 && alphaRange <= 3
}

function hasVisibleInk(canvas: HTMLCanvasElement): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return false
  }

  const probe = document.createElement("canvas")
  probe.width = 64
  probe.height = 64
  const context = probe.getContext("2d")
  if (!context) {
    return true
  }
  context.drawImage(canvas, 0, 0, probe.width, probe.height)
  const { data } = context.getImageData(0, 0, probe.width, probe.height)
  if (!data || data.length === 0) {
    return false
  }

  let darkPixels = 0
  let opaquePixels = 0
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const a = data[index + 3]
    if (a < 10) {
      continue
    }
    opaquePixels += 1
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (luma < 215) {
      darkPixels += 1
    }
  }

  if (opaquePixels <= 0) {
    return false
  }
  const darkRatio = darkPixels / opaquePixels
  return darkPixels >= 12 && darkRatio >= 0.003
}

function isCanvasRenderable(canvas: HTMLCanvasElement): boolean {
  if (isCanvasMostlyUniform(canvas)) {
    return false
  }
  return hasVisibleInk(canvas)
}

function createOffscreenCaptureRoot(source: HTMLElement): {
  root: HTMLElement
  cleanup: () => void
} {
  const host = document.createElement("div")
  host.style.position = "fixed"
  host.style.left = "-100000px"
  host.style.top = "0"
  host.style.zIndex = "-1"
  host.style.pointerEvents = "none"
  host.style.opacity = "1"
  host.style.background = "#FFFFFF"
  host.style.color = "#2D2B28"
  host.style.colorScheme = "light"
  host.style.isolation = "isolate"

  const sourceRect = source.getBoundingClientRect()
  const sourceWidth = Math.round(sourceRect.width || source.clientWidth || source.scrollWidth || 820)
  const exportWidth = Math.max(680, Math.min(1100, sourceWidth))
  host.style.width = `${exportWidth}px`
  host.style.padding = "20px 24px"

  const style = document.createElement("style")
  style.textContent = `
    :host, * {
      color: #2D2B28 !important;
      text-shadow: none !important;
    }
    a {
      color: #7A4A2F !important;
    }
    img {
      display: block !important;
      max-width: 100% !important;
      height: auto !important;
    }
    .grok-md-image {
      width: 100% !important;
      max-height: none !important;
      object-fit: contain !important;
    }
    .text-muted-foreground {
      color: #77746E !important;
    }
  `
  host.appendChild(style)

  const clone = source.cloneNode(true) as HTMLElement
  clone.style.opacity = "1"
  clone.style.transform = "none"
  clone.style.filter = "none"
  clone.style.visibility = "visible"
  clone.style.background = "transparent"
  clone.style.color = "#2D2B28"
  host.appendChild(clone)

  document.body.appendChild(host)

  return {
    root: host,
    cleanup: () => {
      host.remove()
    },
  }
}

async function renderElementPageImages(element: HTMLElement): Promise<string[]> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new Error("pdf_dom_capture_unavailable")
  }

  const { root, cleanup } = createOffscreenCaptureRoot(element)
  try {
    await waitForElementImages(root)

    const scale = Math.max(2, Math.min(window.devicePixelRatio || 1, 3))
    const html2canvasModule = await import("html2canvas")
    const html2canvas = html2canvasModule.default

    let canvas = await html2canvas(root, {
      backgroundColor: "#FFFFFF",
      useCORS: true,
      allowTaint: false,
      logging: false,
      scale,
      imageTimeout: IMAGE_WAIT_TIMEOUT_MS,
      removeContainer: true,
      foreignObjectRendering: true,
      windowWidth: Math.max(root.scrollWidth, root.clientWidth),
      windowHeight: Math.max(root.scrollHeight, root.clientHeight),
      onclone: (clonedDocument) => {
        const html = clonedDocument.documentElement
        const body = clonedDocument.body
        html.classList.remove("dark")
        body.classList.remove("dark")
        html.style.colorScheme = "light"
        for (const [name, value] of Object.entries(EXPORT_THEME_VARS)) {
          html.style.setProperty(name, value)
          body.style.setProperty(name, value)
        }
        body.style.backgroundColor = "#FFFFFF"
        body.style.color = "#2D2B28"
      },
      ignoreElements: (node) => {
        if (!(node instanceof HTMLElement)) {
          return false
        }
        return node.dataset.pdfExportIgnore === "true"
      },
    })
    if (canvas && isCanvasRenderable(canvas)) {
      return splitCanvasIntoPageDataUrls(canvas)
    }

    canvas = await html2canvas(root, {
      backgroundColor: "#FFFFFF",
      useCORS: true,
      allowTaint: false,
      logging: false,
      scale,
      imageTimeout: IMAGE_WAIT_TIMEOUT_MS,
      removeContainer: true,
      foreignObjectRendering: false,
      windowWidth: Math.max(root.scrollWidth, root.clientWidth),
      windowHeight: Math.max(root.scrollHeight, root.clientHeight),
      onclone: (clonedDocument) => {
        const html = clonedDocument.documentElement
        const body = clonedDocument.body
        html.classList.remove("dark")
        body.classList.remove("dark")
        html.style.colorScheme = "light"
        for (const [name, value] of Object.entries(EXPORT_THEME_VARS)) {
          html.style.setProperty(name, value)
          body.style.setProperty(name, value)
        }
        body.style.backgroundColor = "#FFFFFF"
        body.style.color = "#2D2B28"
      },
      ignoreElements: (node) => {
        if (!(node instanceof HTMLElement)) {
          return false
        }
        return node.dataset.pdfExportIgnore === "true"
      },
    })
    if (canvas && isCanvasRenderable(canvas)) {
      return splitCanvasIntoPageDataUrls(canvas)
    }

    throw new Error("pdf_dom_capture_blank")
  } finally {
    cleanup()
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
  if (params.element) {
    try {
      const pageImages = await renderElementPageImages(params.element)
      if (pageImages.length > 0) {
        return buildPdfFromPageImages(pageImages)
      }
    } catch {
      // Fallback to text-only export when DOM capture fails.
    }
  }

  const safeTitle = normalizeConversationTitle(params.title)
  const safeRound = Number.isFinite(params.round) && params.round > 0 ? Math.floor(params.round) : 1
  const headLine = `${safeTitle} · 第${safeRound}轮`
  const normalizedText = normalizeAssistantMarkdown(params.content || "")
    .replace(/!\[(.*?)\]\((.*?)\)/g, "")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
  const lines = [headLine, "", ...buildRenderableLines(normalizedText)]
  const pageImages = renderPageImageDataUrlsFromLines(lines)
  return buildPdfFromPageImages(pageImages)
}
