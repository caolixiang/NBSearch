/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_API_BASE_URL?: string
  readonly VITE_APP_API_KEY?: string
  readonly VITE_APP_DEFAULT_MODEL?: string
  readonly VITE_APP_VOICE_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
