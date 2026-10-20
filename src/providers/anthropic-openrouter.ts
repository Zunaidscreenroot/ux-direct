/**
 * Single source of truth for UX Direct's OpenRouter-backed Anthropic routing.
 * Every model in this chain is published under Anthropic's model namespace.
 * Provider routing is pinned to Anthropic so OpenRouter cannot silently
 * switch these requests to a different model provider.
 */
export const ANTHROPIC_OPENROUTER_MODELS = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-5.5",
] as const;

export const ANTHROPIC_OPENROUTER_PROVIDER = {
  only: ["anthropic"],
  allow_fallbacks: false,
  sort: "throughput",
} as const;
