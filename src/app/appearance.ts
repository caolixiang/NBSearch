import type { AppFontSizeMode, AppThemeMode } from "./contracts"

const SYSTEM_DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)"

let preferredThemeMode: AppThemeMode = "light"
let mediaQueryList: MediaQueryList | null = null
let removeSystemListener: (() => void) | null = null

function getSystemMediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null
  }
  if (!mediaQueryList) {
    mediaQueryList = window.matchMedia(SYSTEM_DARK_MEDIA_QUERY)
  }
  return mediaQueryList
}

function resolveDarkMode(themeMode: AppThemeMode): boolean {
  if (themeMode === "dark") {
    return true
  }
  if (themeMode === "light") {
    return false
  }
  return Boolean(getSystemMediaQueryList()?.matches)
}

function applyThemeToDocument(themeMode: AppThemeMode): void {
  if (typeof document === "undefined") {
    return
  }
  const root = document.documentElement
  const isDark = resolveDarkMode(themeMode)
  root.classList.toggle("dark", isDark)
  root.dataset.themeMode = themeMode
  root.style.colorScheme = isDark ? "dark" : "light"
}

function applyFontSizeToDocument(fontSizeMode: AppFontSizeMode): void {
  if (typeof document === "undefined") {
    return
  }
  const root = document.documentElement
  root.dataset.fontSizeMode = fontSizeMode

  const fontSizePx =
    fontSizeMode === "small" ? "15px" : fontSizeMode === "large" ? "17px" : "16px"
  root.style.setProperty("--app-font-size-px", fontSizePx)
}

function clearSystemThemeListener(): void {
  if (!removeSystemListener) {
    return
  }
  removeSystemListener()
  removeSystemListener = null
}

function attachSystemThemeListener(): void {
  clearSystemThemeListener()
  const media = getSystemMediaQueryList()
  if (!media) {
    return
  }
  const onSystemThemeChange = () => {
    if (preferredThemeMode === "system") {
      applyThemeToDocument("system")
    }
  }
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onSystemThemeChange)
    removeSystemListener = () => media.removeEventListener("change", onSystemThemeChange)
    return
  }
  media.addListener(onSystemThemeChange)
  removeSystemListener = () => media.removeListener(onSystemThemeChange)
}

export function applyAppearanceSettings(input: {
  themeMode: AppThemeMode
  fontSizeMode: AppFontSizeMode
}): void {
  preferredThemeMode = input.themeMode
  applyThemeToDocument(input.themeMode)
  applyFontSizeToDocument(input.fontSizeMode)
  if (input.themeMode === "system") {
    attachSystemThemeListener()
  } else {
    clearSystemThemeListener()
  }
}

