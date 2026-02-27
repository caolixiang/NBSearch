# Phase 3 Tauri Shell Notes

## Delivered

- Added `src-tauri` minimal app:
  - `Cargo.toml`
  - `build.rs`
  - `src/main.rs`
  - `tauri.conf.json`
  - `capabilities/default.json`
- Added Bun scripts:
  - `bun run tauri:dev`
  - `bun run tauri:build`
- Added frontend runtime placeholders:
  - app config loader (`VITE_APP_*`)
  - runtime info bridge (`runtime_info` command)
  - UI display for platform/version/app data dir/log dir

## Runtime Info Command

Rust command `runtime_info` returns:

- `appVersion`
- `platform`
- `appDataDir`
- `appLogDir`

Used by frontend through `@tauri-apps/api/core` `invoke`.

## Env Keys

- `VITE_APP_API_BASE_URL`
- `VITE_APP_API_KEY`
- `VITE_APP_DEFAULT_MODEL`
- `VITE_APP_VOICE_ENABLED`

## Next Step

Phase 4: add SQLite persistence contract implementation and schema migration bootstrap.
