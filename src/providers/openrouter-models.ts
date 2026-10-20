/**
 * UX Direct model priority via OpenRouter.
 * Gemini 3.7 Flash is the quality-first multimodal primary.
 * Fallbacks are ordered by estimated combined input/output cost, cheapest first:
 * Qwen3.5-35B-A3B ($0.08/$0.75), Qwen3.5-397B-A17B ($0.39/$2.34),
 * Gemini 3.5 Flash Lite ($0.30/$2.50) per million tokens.
 * All requests use explicit model IDs; OpenRouter Auto is intentionally not in the chain.
 */
export const OPENROUTER_MODELS = [
  "google/gemini-3.7-flash",
  "qwen/qwen3.5-35b-a3b",
  "qwen/qwen3.5-397b-a17b",
  "google/gemini-3.5-flash-lite",
] as const;

export const OPENROUTER_MODEL_LABELS = [
  "Gemini 3.7 Flash · primary",
  "Qwen 3.5 35B-A3B · cheapest fallback",
  "Qwen 3.5 397B-A17B · quality fallback",
  "Gemini 3.5 Flash Lite · final fallback",
] as const;

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.";
