/**
 * UX Direct capability registry.
 * Add future BFCI capabilities here; the shared chat/API route consumes the
 * resolver rather than maintaining product-specific if/else logic.
 */
export type BfciCapabilityId =
  | "bfci.chat"
  | "bfci.copy"
  | "bfci.screen-edit"
  | "bfci.screen-audit"
  | "bfci.screen-redesign"
  | "bfci.screen-generation"
  | "bfci.journey-design"
  | "bfci.responsive-adaptation"
  | "bfci.design-system"
  | "bfci.banking-risk-review"
  | "bfci.visual-qa"
  | "bfci.handoff";

export type BfciRoutingClass = "free-text" | "low-cost-vision" | "paid-visual" | "paid-reasoning";

export interface BfciCapability {
  id: BfciCapabilityId;
  label: string;
  description: string;
  routingClass: BfciRoutingClass;
  primaryModels: string[];
  fallbackModels: string[];
  requiresImage: boolean;
  paidRequired: boolean;
  structuredOutput: boolean;
  reasoningEffort: "low" | "medium" | "high";
  maxOutputTokens: number;
  maxModelAttempts: number;
  maxRepairPasses: number;
  targetQuality: number;
  maxEstimatedCostUsd: number;
  qualityChecks: string[];
}

export const BFCI_CAPABILITIES: Record<BfciCapabilityId, BfciCapability> = {
  "bfci.chat": {
    id: "bfci.chat",
    label: "Banking product chat",
    description: "Routine questions grounded in the selected design context.",
    routingClass: "free-text",
    primaryModels: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    fallbackModels: [],
    requiresImage: false,
    paidRequired: false,
    structuredOutput: false,
    reasoningEffort: "low",
    maxOutputTokens: 800,
    maxModelAttempts: 2,
    maxRepairPasses: 0,
    targetQuality: 85,
    maxEstimatedCostUsd: 0,
    qualityChecks: ["grounded in supplied context", "concise and actionable"],
  },
  "bfci.copy": {
    id: "bfci.copy",
    label: "Banking UX copy",
    description: "Labels, helper text, disclosures supplied by the product owner, status and error copy.",
    routingClass: "free-text",
    primaryModels: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    fallbackModels: [],
    requiresImage: false,
    paidRequired: false,
    structuredOutput: false,
    reasoningEffort: "low",
    maxOutputTokens: 1000,
    maxModelAttempts: 2,
    maxRepairPasses: 0,
    targetQuality: 90,
    maxEstimatedCostUsd: 0,
    qualityChecks: ["plain language", "no invented financial terms", "preserve supplied amounts and dates"],
  },
  "bfci.screen-edit": {
    id: "bfci.screen-edit",
    label: "Small, scoped Figma edit",
    description: "A bounded content or property edit using the existing layer tree; not a redesign.",
    routingClass: "free-text",
    primaryModels: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    fallbackModels: [],
    requiresImage: false,
    paidRequired: false,
    structuredOutput: true,
    reasoningEffort: "low",
    maxOutputTokens: 1200,
    maxModelAttempts: 2,
    maxRepairPasses: 0,
    targetQuality: 90,
    maxEstimatedCostUsd: 0,
    qualityChecks: ["targets selected nodes only", "safe operation schema", "no unrequested changes"],
  },
  "bfci.screen-audit": {
    id: "bfci.screen-audit",
    label: "Visual screen audit",
    description: "Visual + layer-tree critique of an existing banking screen.",
    routingClass: "low-cost-vision",
    primaryModels: ["anthropic/claude-haiku-5.5", "z-ai/glm-4.6v", "deepseek/deepseek-v4.1-flash"],
    fallbackModels: ["moonshotai/kimi-k2.5", "google/gemini-3.1-pro-preview"],
    requiresImage: true,
    paidRequired: false,
    structuredOutput: true,
    reasoningEffort: "low",
    maxOutputTokens: 1400,
    maxModelAttempts: 3,
    maxRepairPasses: 1,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.03,
    qualityChecks: ["visible evidence", "hierarchy", "density", "legibility", "alignment", "CTA priority", "financial-content preservation"],
  },
  "bfci.screen-redesign": {
    id: "bfci.screen-redesign",
    label: "High-quality screen redesign",
    description: "Substantial layout, hierarchy and component changes applied to a separate clone.",
    routingClass: "paid-visual",
    primaryModels: ["z-ai/glm-4.6v"],
    fallbackModels: ["moonshotai/kimi-k2.5", "anthropic/claude-sonnet-5.5", "google/gemini-3.1-pro-preview"],
    requiresImage: true,
    paidRequired: true,
    structuredOutput: true,
    reasoningEffort: "medium",
    maxOutputTokens: 3200,
    maxModelAttempts: 4,
    maxRepairPasses: 2,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.12,
    qualityChecks: ["structural redesign", "information hierarchy", "payment/action clarity", "banking trust", "layout consistency", "essential financial content preserved", "not a renamed clone"],
  },
  "bfci.screen-generation": {
    id: "bfci.screen-generation",
    label: "New banking screen",
    description: "Generate an editable new screen from requirements and approved reference frames.",
    routingClass: "paid-visual",
    primaryModels: ["z-ai/glm-4.6v", "moonshotai/kimi-k2.5", "anthropic/claude-haiku-5.5"],
    fallbackModels: ["anthropic/claude-sonnet-5.5", "google/gemini-3.1-pro-preview"],
    requiresImage: true,
    paidRequired: true,
    structuredOutput: true,
    reasoningEffort: "medium",
    maxOutputTokens: 3200,
    maxModelAttempts: 3,
    maxRepairPasses: 2,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.12,
    qualityChecks: ["requirements coverage", "reference consistency", "screen hierarchy", "responsive fit", "editable Figma elements"],
  },
  "bfci.journey-design": {
    id: "bfci.journey-design",
    label: "Banking journey / flow",
    description: "Design a multi-step journey with branches, states, errors, retry and completion.",
    routingClass: "paid-reasoning",
    primaryModels: ["deepseek/deepseek-v4.1-flash", "moonshotai/kimi-k2.5", "google/gemini-3.1-pro-preview"],
    fallbackModels: ["anthropic/claude-sonnet-5.5"],
    requiresImage: false,
    paidRequired: true,
    structuredOutput: true,
    reasoningEffort: "medium",
    maxOutputTokens: 3200,
    maxModelAttempts: 3,
    maxRepairPasses: 2,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.15,
    qualityChecks: ["entry and exit conditions", "happy path", "failure paths", "retry logic", "consent and verification states", "cross-screen consistency"],
  },
  "bfci.responsive-adaptation": {
    id: "bfci.responsive-adaptation",
    label: "Responsive adaptation",
    description: "Adapt the information architecture and layout to the target viewport and device.",
    routingClass: "paid-visual",
    primaryModels: ["z-ai/glm-4.6v", "moonshotai/kimi-k2.5", "anthropic/claude-haiku-5.5"],
    fallbackModels: ["google/gemini-3.1-pro-preview", "anthropic/claude-sonnet-5.5"],
    requiresImage: true,
    paidRequired: true,
    structuredOutput: true,
    reasoningEffort: "medium",
    maxOutputTokens: 2800,
    maxModelAttempts: 3,
    maxRepairPasses: 2,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.12,
    qualityChecks: ["responsive reflow", "preserved task hierarchy", "touch target sizing", "desktop space use", "no stretch-only adaptation"],
  },
  "bfci.design-system": {
    id: "bfci.design-system",
    label: "Banking design system",
    description: "Reuse and extend approved tokens, components, variants and interaction patterns.",
    routingClass: "paid-reasoning",
    primaryModels: ["deepseek/deepseek-v4.1-flash", "anthropic/claude-haiku-5.5"],
    fallbackModels: ["anthropic/claude-sonnet-5.5"],
    requiresImage: false,
    paidRequired: true,
    structuredOutput: true,
    reasoningEffort: "low",
    maxOutputTokens: 2400,
    maxModelAttempts: 2,
    maxRepairPasses: 1,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.08,
    qualityChecks: ["token reuse", "component consistency", "variant coverage", "accessible states"],
  },
  "bfci.banking-risk-review": {
    id: "bfci.banking-risk-review",
    label: "Banking trust / risk review",
    description: "Flag potential UX risks around consent, transparency, verification, fees and customer control.",
    routingClass: "low-cost-vision",
    primaryModels: ["anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash"],
    fallbackModels: ["google/gemini-3.1-pro-preview", "anthropic/claude-sonnet-5.5"],
    requiresImage: true,
    paidRequired: false,
    structuredOutput: true,
    reasoningEffort: "medium",
    maxOutputTokens: 2000,
    maxModelAttempts: 3,
    maxRepairPasses: 1,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.05,
    qualityChecks: ["consent clarity", "amount/fee visibility", "customer control", "failure recovery", "uncertainty stated", "not legal approval"],
  },
  "bfci.visual-qa": {
    id: "bfci.visual-qa",
    label: "Visual quality gate",
    description: "Score the edited screenshot against the brief and detect regressions.",
    routingClass: "low-cost-vision",
    primaryModels: ["anthropic/claude-haiku-5.5", "z-ai/glm-4.6v"],
    fallbackModels: ["anthropic/claude-sonnet-5.5"],
    requiresImage: true,
    paidRequired: true,
    structuredOutput: true,
    reasoningEffort: "low",
    maxOutputTokens: 1400,
    maxModelAttempts: 2,
    maxRepairPasses: 2,
    targetQuality: 90,
    maxEstimatedCostUsd: 0.04,
    qualityChecks: ["before/after comparison", "visual hierarchy", "financial content unchanged", "overflow/clipping", "consistency", "task success clarity"],
  },
  "bfci.handoff": {
    id: "bfci.handoff",
    label: "Design handoff",
    description: "Provide component, layout, state and responsive implementation notes.",
    routingClass: "free-text",
    primaryModels: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra-550b-a55b:free"],
    fallbackModels: ["deepseek/deepseek-v4-flash-0731"],
    requiresImage: false,
    paidRequired: false,
    structuredOutput: false,
    reasoningEffort: "low",
    maxOutputTokens: 1400,
    maxModelAttempts: 2,
    maxRepairPasses: 0,
    targetQuality: 85,
    maxEstimatedCostUsd: 0.01,
    qualityChecks: ["clear handoff", "component states", "responsive rules", "no invented business rules"],
  },
};

export interface BfciTaskInput {
  intent?: string;
  prompt: string;
  hasScreenshot: boolean;
}

export function classifyBfciCapability(input: BfciTaskInput): BfciCapability {
  const prompt = input.prompt.toLowerCase();
  const intent = input.intent || "chat";

  // These are the execution paths supported by the current Figma bridge.
  // Additional registry entries remain defined for staged implementation.
  if (intent === "design-variation") return BFCI_CAPABILITIES["bfci.screen-redesign"];

  if (input.hasScreenshot && /\b(?:scan|visually|visual|audit|review|critique|inspect|look at|evaluate|assess|usability)\b/.test(prompt) &&
      !/\b(?:redesign|create|make|build|generate|variation|variant|restyle)\b/.test(prompt)) {
    return BFCI_CAPABILITIES["bfci.screen-audit"];
  }
  if (/\b(?:compliance|consent|credit bureau|fees|charges|interest rate|apr|eligibility disclosure|customer control|hidden charge|deceptive|misleading|banking risk|transparency review)\b/.test(prompt) &&
      !/\b(?:change|edit|modify|update|create|redesign|apply)\b/.test(prompt)) {
    return BFCI_CAPABILITIES["bfci.banking-risk-review"];
  }
  if (/\b(?:handoff|developer specs|implementation notes|dev notes)\b/.test(prompt) && intent === "chat") {
    return BFCI_CAPABILITIES["bfci.handoff"];
  }

  if (intent === "design-operation") {
    const substantial = /\b(?:redesign|rework|restructure|moderni[sz]e|substantial|layout|hierarchy|responsive|new screen|make.+(?:better|clearer|compact|modern|polished)|improve the (?:layout|hierarchy|screen))\b/.test(prompt);
    return input.hasScreenshot && substantial
      ? BFCI_CAPABILITIES["bfci.screen-redesign"]
      : BFCI_CAPABILITIES["bfci.screen-edit"];
  }

  if (/\b(?:writeup|write[- ]?up|copy|microcopy|button label|error message|helper text|empty state|success message|toast|title|subtitle)\b/.test(prompt)) {
    return BFCI_CAPABILITIES["bfci.copy"];
  }
  if (input.hasScreenshot && /\b(?:scan|visually|visual|audit|review|critique|inspect|look at|evaluate|assess|usability)\b/.test(prompt)) {
    return BFCI_CAPABILITIES["bfci.screen-audit"];
  }
  return BFCI_CAPABILITIES["bfci.chat"];
}

export function orderedModelIds(capability: BfciCapability): string[] {
  return [...capability.primaryModels, ...capability.fallbackModels];
}
