/**
 * Figma generation, visual QA, and surgical refinement use explicit OpenRouter
 * routes. Prefer the stronger vision-language model for first-pass accuracy;
 * try the cheaper Qwen route only when the primary route fails validation.
 * Avoid Auto routing here because it can select a weak model for complex visual
 * preservation tasks without telling the user why quality fell.
 */
export const FIGMA_AGENT_MODELS = [
  {
    id: "qwen/qwen3.5-397b-a17b",
    label: "Qwen 3.5 397B-A17B · quality-first",
    description: "Primary vision-language route for source-faithful editable Figma generation and visual QA.",
    price: "$0.39/M input · $2.34/M output",
  },
  {
    id: "qwen/qwen3.5-35b-a3b",
    label: "Qwen 3.5 35B-A3B · lower-cost fallback",
    description: "Sequential fallback when the primary route fails or returns an invalid plan.",
    price: "$0.08/M input · $0.75/M output",
  },
] as const;

export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "qwen/qwen3.5-397b-a17b";
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "qwen/qwen3.5-397b-a17b";

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
