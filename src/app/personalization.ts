export const DEFAULT_APP_TIMEZONE = "Asia/Shanghai"

export type AppTimezoneOption = {
  value: string
  label: string
}

export const APP_TIMEZONE_OPTIONS: AppTimezoneOption[] = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai（上海 / 北京时间）" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo（东京）" },
  { value: "Asia/Singapore", label: "Asia/Singapore（新加坡）" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles（洛杉矶）" },
  { value: "America/New_York", label: "America/New_York（纽约）" },
  { value: "Europe/London", label: "Europe/London（伦敦）" },
  { value: "Europe/Berlin", label: "Europe/Berlin（柏林）" },
]

export function normalizeAppTimezone(value: string | undefined): string {
  const normalized = typeof value === "string" ? value.trim() : ""
  return normalized || DEFAULT_APP_TIMEZONE
}

export function resolveAppTimezoneOptions(currentValue: string | undefined): AppTimezoneOption[] {
  const normalized = normalizeAppTimezone(currentValue)
  if (APP_TIMEZONE_OPTIONS.some((option) => option.value === normalized)) {
    return APP_TIMEZONE_OPTIONS
  }
  return [{ value: normalized, label: `${normalized}（自定义）` }, ...APP_TIMEZONE_OPTIONS]
}
