import type { ChatAttachment } from "@/domain/chat/types"

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif", "heic", "heif"])
const IMAGE_PREVIEW_SIZE_PX = 96

type AttachmentLike = {
  name?: string
  type?: string
}

type BuildChatAttachmentsOptions = {
  previewBuilder?: (file: File) => Promise<string>
}

export function getAttachmentExtension(fileName: string): string {
  const normalized = fileName.trim()
  const lastDotIndex = normalized.lastIndexOf(".")
  if (lastDotIndex <= 0 || lastDotIndex === normalized.length - 1) {
    return ""
  }
  return normalized.slice(lastDotIndex + 1).trim().toLowerCase()
}

export function isImageAttachmentLike(input: AttachmentLike): boolean {
  const mimeType = (input.type || "").trim().toLowerCase()
  if (mimeType.startsWith("image/")) {
    return true
  }
  return IMAGE_EXTENSIONS.has(getAttachmentExtension(input.name || ""))
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("image_preview_filereader_unsupported"))
      return
    }

    const reader = new FileReader()
    reader.onerror = () => reject(new Error("image_preview_read_failed"))
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "")
    }
    reader.readAsDataURL(file)
  })
}

function renderPreviewDataUrl(source: CanvasImageSource, width: number, height: number): string {
  if (typeof document === "undefined") {
    return ""
  }

  const canvas = document.createElement("canvas")
  canvas.width = IMAGE_PREVIEW_SIZE_PX
  canvas.height = IMAGE_PREVIEW_SIZE_PX
  const context = canvas.getContext("2d")
  if (!context) {
    return ""
  }

  const naturalWidth = Math.max(1, width || IMAGE_PREVIEW_SIZE_PX)
  const naturalHeight = Math.max(1, height || IMAGE_PREVIEW_SIZE_PX)
  const scale = Math.max(IMAGE_PREVIEW_SIZE_PX / naturalWidth, IMAGE_PREVIEW_SIZE_PX / naturalHeight)
  const drawWidth = naturalWidth * scale
  const drawHeight = naturalHeight * scale
  const drawX = (IMAGE_PREVIEW_SIZE_PX - drawWidth) / 2
  const drawY = (IMAGE_PREVIEW_SIZE_PX - drawHeight) / 2

  context.clearRect(0, 0, IMAGE_PREVIEW_SIZE_PX, IMAGE_PREVIEW_SIZE_PX)
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight)
  return canvas.toDataURL("image/png")
}

export async function createImagePreviewDataUrl(file: File): Promise<string> {
  if (!isImageAttachmentLike(file)) {
    return ""
  }
  if (typeof document === "undefined") {
    return ""
  }

  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file)
      try {
        const previewDataUrl = renderPreviewDataUrl(bitmap, bitmap.width, bitmap.height)
        if (previewDataUrl) {
          return previewDataUrl
        }
      } finally {
        bitmap.close()
      }
    }
  } catch {
    // Fall through to the data-url fallback below.
  }

  return readFileAsDataUrl(file).catch(() => "")
}

export async function buildChatAttachments(
  files: File[],
  options?: BuildChatAttachmentsOptions
): Promise<ChatAttachment[]> {
  const previewBuilder = options?.previewBuilder || createImagePreviewDataUrl
  const normalized = Array.isArray(files) ? files.filter((file) => Boolean(file)) : []
  const attachments = await Promise.all(
    normalized.map(async (file) => {
      const name = (file.name || "").trim() || "attachment"
      const kind: ChatAttachment["kind"] = isImageAttachmentLike(file) ? "image" : "file"
      const extension = getAttachmentExtension(name)
      const previewImageUrl = kind === "image" ? await previewBuilder(file).catch(() => "") : ""
      return {
        name,
        kind,
        ...(extension ? { extension } : {}),
        ...(previewImageUrl ? { previewImageUrl } : {}),
      } satisfies ChatAttachment
    })
  )
  return attachments
}
