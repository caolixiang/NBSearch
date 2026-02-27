export interface ChatModelOption {
  id: string
  name: string
  provider: string
}

export const CHAT_MODELS: ChatModelOption[] = [
  {
    id: "grok-4.1-fast",
    name: "Grok 4.1 Fast",
    provider: "Gateway",
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    provider: "Gateway",
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "Anthropic",
  },
  {
    id: "anthropic/claude-opus-4-1",
    name: "Claude Opus 4.1",
    provider: "Anthropic",
  },
]
