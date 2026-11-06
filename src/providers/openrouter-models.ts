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

/**
 * Sent to every model on every UX Direct route (it is part of UX_DIRECT_DESIGN_ROLE), so free
 * models get the same anti-hallucination and anti-slop contract whichever one `auto` picks.
 */
export const UX_DIRECT_GROUNDING_RULES =
  "GROUNDING: use only facts in the user's request, the source layers, the screenshot and the supplied context. Never invent features, data, names, brands, numbers, rates, dates, reviews, legal or compliance claims, or component IDs. When a value is unknown, keep the source value or label it sample. Never claim a check, measurement or visual inspection you did not do. " +
  "NO AI SLOP: no generic filler copy (lorem ipsum, 'Welcome back!', 'Unlock your potential', 'Seamless experience', 'Get started today'), no decorative gradients, glows, emoji or stock-style hero sections that the source lacks, no made-up stat cards or charts, no repeated identical cards to fill space, no vague 'Learn more' buttons. Every element must serve the user's task; prefer fewer, purposeful elements, the product's own language, one clear primary action and consistent spacing.";

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.\n" +
  UX_DIRECT_GROUNDING_RULES;
