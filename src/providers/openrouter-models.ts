/**
 * UX Direct model priority via OpenRouter.
 * Gemini 3.7 Flash is the quality-first multimodal primary.
 * Claude Haiku 5.5 is the first recovery model because it supports image input
 * and structured JSON output. Qwen and Gemini Lite remain additional fallbacks.
 * All requests use explicit model IDs; OpenRouter Auto is intentionally not in the chain.
 */
export const OPENROUTER_MODELS = [
  "google/gemini-3.7-flash",
  "anthropic/claude-haiku-5.5",
  "qwen/qwen3.5-35b-a3b",
  "google/gemini-3.1-flash-lite",
  "qwen/qwen3.5-397b-a17b",
] as const;

export const OPENROUTER_MODEL_LABELS = [
  "Gemini 3.7 Flash · primary",
  "Claude Haiku 5.5 · structured-output fallback",
  "Qwen 3.5 35B-A3B · low-cost fallback",
  "Gemini 3.1 Flash Lite · low-cost multimodal fallback",
  "Qwen 3.5 397B-A17B · final quality fallback",
] as const;

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.";
