/** Shared FreeLLMAPI model routing identifiers. The gateway owns upstream model selection and failover. */
export const FREELLMAPI_MODELS = ["auto"] as const;
export const FREELLMAPI_MODEL_LABELS = ["FreeLLMAPI Auto · provider-managed routing"] as const;

export const FIGMA_AGENT_MODELS = [
  {
    id: "auto",
    label: "FreeLLMAPI Auto · generation and review",
    description: "FreeLLMAPI selects a currently available upstream model and manages provider failover.",
    price: "Provider-managed routing; check current upstream quotas.",
  },
] as const;

export type FigmaAgentModelId = typeof FIGMA_AGENT_MODELS[number]["id"];
export const FIGMA_AGENT_DEFAULT_MODEL: FigmaAgentModelId = "auto";
export const FIGMA_AGENT_QA_MODEL: FigmaAgentModelId = "auto";

export const UX_DIRECT_DESIGN_ROLE =
  "Act as a senior UI/UX designer and expert native Figma designer. Prioritize source-faithful, production-ready interfaces, strong information hierarchy, readable typography, consistent spacing, accessible contrast, meaningful real content, and editable native Figma layers.";
