/**
 * Models curated for UX Direct's native Figma screen-generation task.
 * The agent consumes a rendered screenshot (when available) plus native Figma
 * layer data and must return structured JSON for editable native layers.
 */
export const FIGMA_AGENT_MODELS = [
  { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash · Recommended", description: "Multimodal baseline with structured JSON output.", price: "$0.75 input / $3.75 output per 1M tokens" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 · Premium", description: "Premium visual/instruction-following comparison.", price: "$2.00 input / $10.00 output per 1M tokens" },
  { id: "openai/gpt-5.4", label: "GPT-5.4 · Premium", description: "Strong instruction following and multimodal reasoning.", price: "$2.50 input / $15.00 output per 1M tokens" },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 · Value", description: "Lower-cost multimodal option with structured outputs.", price: "$0.10 input / $0.50 output per 1M tokens" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite · Budget", description: "Fast, low-cost multimodal comparison.", price: "$0.25 input / $1.50 output per 1M tokens" },
] as const;

export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "google/gemini-3.7-flash";
/** Fixed visual-QA judge so model comparisons use a consistent reviewer. */
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "google/gemini-3.7-flash";

/** Legacy fallback order retained for endpoints outside selected-model generation. */
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
