/**
 * Models curated for UX Direct's native Figma screen-generation task.
 * The agent consumes a rendered screenshot (when available) plus native Figma
 * layer data and must return structured JSON for editable native layers.
 */
export const FIGMA_AGENT_MODELS = [
  { id: "openrouter/auto", label: "OpenRouter Auto · LOW cost", description: "Routes each request through OpenRouter's LOW cost tier.", price: "Variable · restricted to the LOW cost tier" },
] as const;


export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "openrouter/auto";
/** Fixed visual-QA judge so model comparisons use a consistent reviewer. */
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "openrouter/auto";

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
