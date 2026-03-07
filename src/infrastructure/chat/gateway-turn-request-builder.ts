const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

type ResponsesInputContentBlock =
  | {
      type: "text"
      text: string
    }
  | {
      type: "image_url"
      image_url: {
        url: string
      }
    }
  | {
      type: "file"
      file: {
        file_data: string
      }
    }

type BuildGatewayTurnRequestPayloadInput = {
  model: string
  sessionId: string
  clientTurnId: string
  text: string
  attachments?: File[]
  anchoredSessionId?: string
  fallbackPreviousResponseId?: string
  regenerateTargetResponseId?: string
}

function normalizeAttachmentFiles(attachments?: File[]): File[] {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return []
  }
  return attachments.filter((file) => Boolean(file))
}

export function buildUserMessageText(text: string, attachments?: File[]): string {
  const content = text.trim()
  const files = normalizeAttachmentFiles(attachments)
  if (files.length === 0) {
    return content
  }
  const attachmentLines = files.map((file) => `[附件] ${file.name}`)
  if (!content) {
    return attachmentLines.join("\n")
  }
  return `${content}\n\n${attachmentLines.join("\n")}`
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return globalThis.btoa(binary)
}

async function fileToDataUri(file: File): Promise<string> {
  const mimeType = file.type?.trim() || "application/octet-stream"
  const buffer = await file.arrayBuffer()
  const base64 = arrayBufferToBase64(buffer)
  return `data:${mimeType};base64,${base64}`
}

function isImageAttachment(file: File): boolean {
  const mimeType = file.type?.trim().toLowerCase() || ""
  if (mimeType.startsWith("image/")) {
    return true
  }
  return /\.(?:png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name)
}

async function buildResponsesInputContent(
  text: string,
  attachments?: File[]
): Promise<ResponsesInputContentBlock[]> {
  const blocks: ResponsesInputContentBlock[] = []
  const content = text.trim()
  const files = normalizeAttachmentFiles(attachments)

  if (content) {
    blocks.push({
      type: "text",
      text: content,
    })
  }

  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件过大：${file.name}，当前上限约 50MB`)
    }
    const dataUri = await fileToDataUri(file)
    if (isImageAttachment(file)) {
      blocks.push({
        type: "image_url",
        image_url: {
          url: dataUri,
        },
      })
      continue
    }
    blocks.push({
      type: "file",
      file: {
        file_data: dataUri,
      },
    })
  }

  if (!content && files.length > 0) {
    blocks.unshift({
      type: "text",
      text: "请分析这个附件。",
    })
  }

  return blocks
}

export async function buildGatewayTurnRequestPayload(
  input: BuildGatewayTurnRequestPayloadInput
): Promise<Record<string, unknown>> {
  const regenerateTargetResponseId = input.regenerateTargetResponseId?.trim() || ""
  const previousResponseId =
    !input.anchoredSessionId?.trim() && input.fallbackPreviousResponseId?.trim()
      ? input.fallbackPreviousResponseId.trim()
      : ""

  const requestBodyPayload: Record<string, unknown> = {
    model: input.model,
    session_id: input.sessionId,
    client_turn_id: input.clientTurnId,
    stream: true,
  }

  if (regenerateTargetResponseId) {
    requestBodyPayload["x_grok"] = {
      regenerate: true,
      target_response_id: regenerateTargetResponseId,
    }
    return requestBodyPayload
  }

  const contentBlocks = await buildResponsesInputContent(input.text, input.attachments)
  requestBodyPayload["input"] = [
    {
      role: "user",
      content: contentBlocks,
    },
  ]
  if (previousResponseId) {
    requestBodyPayload["previous_response_id"] = previousResponseId
  }
  return requestBodyPayload
}
