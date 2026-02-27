# Phase 5 Provider Routing Notes

## Goal

Use AI SDK as unified runtime with multi-provider routing:

- Gateway via OpenAI-compatible responses endpoint
- Anthropic Claude via `/v1/messages`

## Delivered

- Added providers:
  - `@ai-sdk/openai`
  - `@ai-sdk/anthropic`
- Added provider router:
  - routes `anthropic/*` and `claude*` models to Anthropic provider
  - routes all others to gateway OpenAI-compatible provider
- Added AI SDK chat service:
  - streams text with `streamText`
  - emits `started/delta/completed/failed`
  - persists assistant text and `response_id` into repository
- Added app runtime composer:
  - centralizes config + services wiring

## Anchor Strategy (Current)

- Persisted anchors:
  - `conversation_id`
  - `last_response_id`
- `session_id` is preserved in contract and storage schema; wiring to gateway-specific request field will be added in the next protocol adaptation pass.
