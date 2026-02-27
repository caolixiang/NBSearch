# Bun Toolchain Contract (Phase 0)

## Decision

- Package manager and script runner: Bun only.
- Node.js fallback: not provided.

## Minimum Version

- Bun >= 1.1

## Required Commands

- Install: `bun install`
- Dev: `bun run dev`
- Build: `bun run build`
- Lint: `bun run lint`
- Test: `bun run test` (when tests are introduced)

## CI Requirement

- CI must pin Bun version explicitly.
- CI must fail fast if Bun is missing or version is below minimum.

## Package/Lockfile Policy

- Primary lockfile: `bun.lockb` (after migration scripts are switched).
- Legacy lockfiles from prior stack should be removed only in the cleanup phase.

## Developer Notes

- New scripts should be Bun-compatible.
- Avoid Node-specific runtime assumptions in scripts unless replaced by Bun-compatible alternatives.
