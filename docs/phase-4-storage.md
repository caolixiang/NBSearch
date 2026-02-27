# Phase 4 Storage Notes

## Delivered

- Added SQLite plugin integration:
  - JS: `@tauri-apps/plugin-sql`
  - Rust: `tauri-plugin-sql` with `sqlite` feature
- Registered SQL plugin in Tauri builder.
- Added schema migration bootstrap with `schema_migrations`.
- Implemented repository contracts:
  - SQLite repository (Tauri runtime)
  - Memory repository (web/dev fallback)
- Added repository factory to switch by runtime.

## Schema (v1)

- `conversations`
- `messages`
- `voice_sessions`
- `schema_migrations`

## Migration Strategy

- On first DB access, `getDatabase()` runs pending migrations sequentially.
- Applied migration versions are persisted in `schema_migrations`.

## Runtime Behavior

- Tauri runtime: uses SQLite file `sqlite:chat-app.db`.
- Non-Tauri runtime: uses in-memory repository for local web shell development.
