# Phase 1 Architecture Notes

## Goal

Build a new application skeleton that treats existing code as UI asset source only.

## Reuse Policy

- Reuse first: visual UI components and styling details.
- Rewrite by default: routing, API calls, state orchestration, persistence, voice runtime.

## New Layering

1. `src/domain/chat/*`
   - Chat message and anchor types.
   - Chat streaming contract independent of framework.
2. `src/domain/storage/*`
   - Repository contract for conversations/messages/voice sessions.
3. `src/domain/voice/*`
   - Voice token + session event contract aligned to gateway API.
4. `src/app/contracts.ts`
   - Runtime composition boundary (`config` + `services`).

## Why This Split

- Keeps UI independent from provider and gateway protocol changes.
- Makes Responses anchors (`session_id/conversation_id/response_id`) explicit.
- Allows Tauri SQLite and LiveKit integration without leaking infra details into UI components.
