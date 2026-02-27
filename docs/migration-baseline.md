# Migration Baseline (Phase 0)

## Snapshot Date

- Captured at: 2026-02-27
- Scope: pre-migration baseline before Tauri rewrite

## Current App Baseline

- Framework: Next.js (App Router style)
- Main entry:
  - `app/layout.tsx`
  - `app/page.tsx`
- Chat API route:
  - `app/api/chat/route.ts`
- UI assets and component library are present and reusable:
  - `components/*`
  - `styles/*`
  - `public/*`

## Key User Flows To Preserve

1. Open app and render main chat layout.
2. Send text message and see assistant stream response.
3. Switch model from selector.
4. Open settings dialog.
5. Open voice mode overlay.
6. Scroll history with stable viewport behavior.

## Runtime and Env Naming Draft

- `APP_ENV=development|staging|production`
- `APP_API_BASE_URL=<gateway_base_url>`
- `APP_API_KEY=<gateway_key>`
- `APP_DEFAULT_MODEL=<model_id>`
- `APP_VOICE_ENABLED=true|false`

Notes:
- `APP_*` is frontend-visible scope.
- Secrets should be injected by Tauri runtime config, not hardcoded in UI source.

## Migration Non-Goals (Phase 0)

- No functional rewrite yet.
- No build tool switch in this phase.
- No API contract changes in this phase.

## Acceptance Checklist (Phase 0)

- [x] Baseline architecture and flow list documented.
- [x] Env naming draft documented.
- [x] Bun toolchain constraints documented in separate file.
- [x] Phase commit completed with `phase(0): ...` message.
