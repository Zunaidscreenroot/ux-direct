/**
 * Figma generation, review, and refinement use GPT-6 Luna as the primary route.
 * OpenRouter Auto is the low-cost fallback if the primary route fails.
 */
export const FIGMA_AGENT_MODELS = [
  {
    id: "openai/gpt-6-luna",
    label: "OpenAI GPT-6 Luna · primary",
    description: "Primary multimodal route for source-faithful Figma generation, visual QA, and refinement through OpenRouter.",
    price: "$0.10/M input · $0.50/M output",
  },
  {
    id: "openrouter/auto",
    label: "OpenRouter Auto · low-cost fallback",
    description: "Low-cost fallback when GPT-6 Luna times out, returns an error, or produces an invalid response.",
    price: "LOW cost tier only",
  },
] as const;

export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "openai/gpt-6-luna";
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "openai/gpt-6-luna";

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
