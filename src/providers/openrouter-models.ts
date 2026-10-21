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
    id: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash · vision fallback",
    description: "OpenRouter-hosted multimodal fallback for source-faithful Figma plans.",
    price: "OpenRouter listed pricing varies by provider",
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
 * General assistant chat exposes one server-selected route. OpenRouter Auto
 * chooses the actual model dynamically within the requested low-cost tier.
 * Figma generation/review remains a separate, explicit quality-first route.
 */
export const OPENROUTER_MODELS = [
  "openrouter/auto",
] as const;

export const OPENROUTER_MODEL_LABELS = [
  "OpenRouter Auto · low-cost routing",
] as const;

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.";
