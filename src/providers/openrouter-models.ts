/**
 * Explicit models for UX Direct's native Figma design tasks.
 * Fallbacks are sequential and cost-ordered; OpenRouter Auto is intentionally not used.
 */
export const FIGMA_AGENT_MODELS = [
  {
    id: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash · primary",
    description: "Primary model for source-faithful native Figma design generation.",
    price: "Primary route; fallbacks are called only if a valid plan is not returned",
  },
] as const;

export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "google/gemini-3.7-flash";
/** Compatibility alias; review endpoints use the same shared explicit fallback chain. */
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "google/gemini-3.7-flash";

export const OPENROUTER_MODELS = [
  "google/gemini-3.7-flash",
  "qwen/qwen3.5-35b-a3b",
  "google/gemini-3.1-flash-lite",
  "qwen/qwen3.5-397b-a17b",
] as const;

export const OPENROUTER_MODEL_LABELS = [
  "Gemini 3.7 Flash · primary",
  "Qwen 3.5 35B-A3B · cheapest fallback",
  "Gemini 3.1 Flash Lite · low-cost multimodal fallback",
  "Qwen 3.5 397B-A17B · final quality fallback",
] as const;

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.";
