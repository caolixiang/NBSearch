const CHROME_STABLE_VERSION = "145.0.7632.110"
const CHROME_MAJOR_VERSION = "145"

function detectChromePlatform(): { uaPlatform: string; secPlatform: string } {
  if (typeof navigator !== "undefined") {
    const platform = (navigator.platform || "").toLowerCase()
    if (platform.includes("mac")) {
      return { uaPlatform: "Macintosh; Intel Mac OS X 10_15_7", secPlatform: "macOS" }
    }
    if (platform.includes("win")) {
      return { uaPlatform: "Windows NT 10.0; Win64; x64", secPlatform: "Windows" }
    }
    if (platform.includes("linux")) {
      return { uaPlatform: "X11; Linux x86_64", secPlatform: "Linux" }
    }
  }
  return { uaPlatform: "Macintosh; Intel Mac OS X 10_15_7", secPlatform: "macOS" }
}

export function buildGrokChromeImageHeaders(): Record<string, string> {
  const { uaPlatform, secPlatform } = detectChromePlatform()

  return {
    Referer: "https://grok.com/",
    // Keep Origin empty so tauri-plugin-http removes it (unsafe-headers mode),
    // matching browser <img> behavior for most cross-site image requests.
    Origin: "",
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    "Sec-CH-UA": `"Google Chrome";v="${CHROME_MAJOR_VERSION}", "Chromium";v="${CHROME_MAJOR_VERSION}", "Not:A-Brand";v="24"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${secPlatform}"`,
    "User-Agent": `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_STABLE_VERSION} Safari/537.36`,
  }
}
