# Phase 8 Release Notes

## Packaging Commands

- Debug package:
  - `bun run tauri:build:debug`
- Release package:
  - `bun run tauri:build`

## Preflight Gate

Before any release candidate:

1. `bun run release:preflight`
2. `bun run tauri:build:debug`
3. smoke check startup on target OS

## Suggested Rollout

1. Internal dogfood build (small user set)
2. Limited beta rollout
3. Full rollout after error-rate validation

## Blocking Conditions

- Rust crates registry/network unavailable (cannot resolve `index.crates.io`).
- Missing signing/notarization credentials for production bundle.

## Post-Release Checks

- Verify chat stream continuity (`response_id` persisted).
- Verify voice connect/disconnect reports session events correctly.
- Verify local SQLite schema migration runs on clean install.
