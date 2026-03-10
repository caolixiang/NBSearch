import { DEFAULT_APP_TIMEZONE, normalizeAppTimezone } from "../../app/personalization"

const TIMEZONE_LOCATION_LABELS: Record<string, string> = {
  "Asia/Shanghai": "Shanghai, China",
  "Asia/Tokyo": "Tokyo, Japan",
  "Asia/Singapore": "Singapore",
  "America/Los_Angeles": "Los Angeles, California, United States",
  "America/New_York": "New York, New York, United States",
  "Europe/London": "London, United Kingdom",
  "Europe/Berlin": "Berlin, Germany",
  UTC: "UTC",
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function resolveSupportedTimezone(timezone: string): string {
  const normalized = normalizeAppTimezone(timezone)
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date())
    return normalized
  } catch {
    return DEFAULT_APP_TIMEZONE
  }
}

function normalizeOffsetLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === "GMT" || trimmed === "UTC") {
    return "UTC+00:00"
  }
  const match = trimmed.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i)
  if (!match) {
    return "UTC+00:00"
  }
  const sign = match[1]
  const hours = match[2].padStart(2, "0")
  const minutes = (match[3] || "00").padStart(2, "0")
  return `UTC${sign}${hours}:${minutes}`
}

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value || ""
}

function formatTurnLocalDateTime(timezone: string, now: Date): {
  localDateTime: string
  offsetLabel: string
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  })
  const parts = formatter.formatToParts(now)
  const year = getPart(parts, "year")
  const month = getPart(parts, "month")
  const day = getPart(parts, "day")
  const hour = getPart(parts, "hour")
  const minute = getPart(parts, "minute")
  const second = getPart(parts, "second")
  const offsetLabel = normalizeOffsetLabel(getPart(parts, "timeZoneName"))
  return {
    localDateTime: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    offsetLabel,
  }
}

export function resolveConversationLocation(timezone: string): string {
  const normalized = resolveSupportedTimezone(timezone)
  return TIMEZONE_LOCATION_LABELS[normalized] || normalized
}

export function buildConversationLocaleInstructions(timezone: string): string {
  const normalized = resolveSupportedTimezone(timezone)
  const location = resolveConversationLocation(normalized)
  return [
    "<system_context>",
    "  <user_locale>",
    `    <timezone>${escapeXmlText(normalized)}</timezone>`,
    `    <location>${escapeXmlText(location)}</location>`,
    "  </user_locale>",
    "  <time_policy>",
    "    <rule>Default to assuming the user is currently located in the timezone and location above.</rule>",
    "    <rule>For questions involving now, today, tomorrow, yesterday, the last 24 hours, the last 48 hours, this week, this month, local time, date boundaries, schedules, or relative-time interpretation, use the timezone above unless the user explicitly requests another timezone.</rule>",
    "    <rule>Unless the user explicitly requests another timezone, do not switch to UTC, server time, IP-derived time, or any model-default timezone.</rule>",
    "    <rule>If a response could be ambiguous because of timezone differences, explicitly state the timezone you are using.</rule>",
    "  </time_policy>",
    "</system_context>",
  ].join("\n")
}

export function buildTurnTimeContextSuffix(timezone: string, now = new Date()): string {
  const normalized = resolveSupportedTimezone(timezone)
  const { localDateTime, offsetLabel } = formatTurnLocalDateTime(normalized, now)
  return `[Authoritative current local time for this turn only: ${localDateTime} ${normalized} (${offsetLabel}). Ignore any earlier turn times and use this time as the reference for this turn.]`
}
