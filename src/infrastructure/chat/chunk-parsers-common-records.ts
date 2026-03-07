export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJsonObjectStrings(raw: string): string[] {
  const input = raw.trim()
  if (!input || input === "[DONE]") {
    return []
  }

  const segments: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (start < 0) {
      if (char === "{") {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") {
      depth += 1
      continue
    }
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        segments.push(input.slice(start, index + 1))
        start = -1
      }
    }
  }

  return segments
}

export function parseRecords(value: unknown): Record<string, unknown>[] {
  if (isRecord(value)) {
    return [value]
  }
  if (typeof value !== "string") {
    return []
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed === "[DONE]") {
    return []
  }

  const records: Record<string, unknown>[] = []
  for (const candidate of parseJsonObjectStrings(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isRecord(parsed)) {
        records.push(parsed)
      }
    } catch {
      continue
    }
  }
  if (records.length > 0) {
    return records
  }

  const sseLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))

  for (const line of sseLines) {
    const payload = line.slice("data:".length).trim()
    if (!payload || payload === "[DONE]") {
      continue
    }
    for (const candidate of parseJsonObjectStrings(payload)) {
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (isRecord(parsed)) {
          records.push(parsed)
        }
      } catch {
        continue
      }
    }
  }

  return records
}

export function collectRawChunkCandidates(rawChunk: unknown): Record<string, unknown>[] {
  const parsedRecords = parseRecords(rawChunk)
  if (parsedRecords.length === 0) {
    return []
  }

  const candidates: Record<string, unknown>[] = []
  const seen = new Set<Record<string, unknown>>()

  const append = (value: unknown) => {
    if (!isRecord(value) || seen.has(value)) {
      return
    }
    seen.add(value)
    candidates.push(value)
  }

  for (const parsed of parsedRecords) {
    append(parsed)
    append(parsed.result)
    append(parsed.response)

    if (isRecord(parsed.result)) {
      append(parsed.result.response)
      append(parsed.result.title)
      append(parsed.result.conversation)
      append(parsed.result.modelResponse)
      if (isRecord(parsed.result.response)) {
        append(parsed.result.response.modelResponse)
      }
    }
  }

  return candidates
}
