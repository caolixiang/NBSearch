const PDF_PAGE_WIDTH_PT = 595.28
const PDF_PAGE_HEIGHT_PT = 841.89

const PAGE_RASTER_WIDTH = 1240
const PAGE_RASTER_HEIGHT = 1754
const PAGE_PADDING_X = 72
const PAGE_PADDING_TOP = 96
const PAGE_PADDING_BOTTOM = 88
const PAGE_FONT_SIZE = 28
const PAGE_LINE_HEIGHT = 42
const MAX_TITLE_LENGTH = 64

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

function renderPageImageDataUrls(lines: string[]): string[] {
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

export async function buildMessagePdfBytes(params: {
  title: string
  round: number
  content: string
}): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib")
  const safeTitle = normalizeConversationTitle(params.title)
  const safeRound = Number.isFinite(params.round) && params.round > 0 ? Math.floor(params.round) : 1
  const headLine = `${safeTitle} · 第${safeRound}轮`
  const lines = [headLine, "", ...buildRenderableLines(params.content || "")]
  const pageImages = renderPageImageDataUrls(lines)

  const pdf = await PDFDocument.create()
  for (const imageDataUrl of pageImages) {
    const image = await pdf.embedJpg(imageDataUrl)
    const page = pdf.addPage([PDF_PAGE_WIDTH_PT, PDF_PAGE_HEIGHT_PT])
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: PDF_PAGE_WIDTH_PT,
      height: PDF_PAGE_HEIGHT_PT,
    })
  }

  return pdf.save()
}
