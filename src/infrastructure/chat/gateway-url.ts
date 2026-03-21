function normalizeTrimmedUrl(input: string): string {
  return input.trim().replace(/\/+$/, "")
}

export function normalizeGatewayResponsesUrl(input: string): string {
  const trimmed = normalizeTrimmedUrl(input)
  if (!trimmed) {
    return "http://localhost:8787/v1/responses"
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/responses`
  }
  return `${trimmed}/v1/responses`
}

export function normalizeGatewayBaseUrl(input: string): string {
  const trimmed = normalizeTrimmedUrl(input)
  if (!trimmed) {
    return "http://localhost:8787/v1"
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed
  }
  if (trimmed.endsWith("/v1/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  if (trimmed.endsWith("/responses")) {
    return trimmed.slice(0, -"/responses".length)
  }
  return `${trimmed}/v1`
}
