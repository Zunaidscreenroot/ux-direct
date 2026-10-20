/**
 * Figma design generation uses OpenRouter Auto first, capped at LOW cost tier.
 * If Auto returns no valid plan, try vision-capable low-cost models in ascending price order.
 */
export const FIGMA_AGENT_MODELS = [
  {
    id: "openrouter/auto",
    label: "OpenRouter Auto · LOW cost tier",
    description: "Primary route; OpenRouter selects a capable model within the LOW cost tier.",
    price: "LOW cost tier only",
  },
  {
    id: "qwen/qwen3.5-35b-a3b",
    label: "Qwen 3.5 35B-A3B · cheapest fallback",
    description: "Vision-language fallback with low input and output cost.",
    price: "$0.08/M input · $0.75/M output",
  },
  {
    id: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite · low-cost fallback",
    description: "Multimodal fallback for structured native Figma plan generation.",
    price: "$0.25/M input · $1.50/M output",
  },
  {
    id: "qwen/qwen3.5-397b-a17b",
    label: "Qwen 3.5 397B-A17B · quality fallback",
    description: "Higher-capability vision-language fallback, tried only after cheaper routes fail.",
    price: "$0.39/M input · $2.34/M output",
  },
] as const;

export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "openrouter/auto";
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "openrouter/auto";

/**
 * General assistant/chat routing stays separate, so design model changes do not
 * silently change homepage chat behavior.
 */
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
