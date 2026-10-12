/**
 * Explicit model pool for the UX Direct Figma cockpit.
 * These IDs are the only OpenRouter models exposed by the cockpit.
 * Free calls are preferred; the paid pool is selected by the user's exact choice
 * or one bounded fallback. Prices are public list rates; the live catalogue is
 * checked again before paid models are enabled in the UI.
 */
export const OPENROUTER_FREE_CHAT_MODELS = [
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "NVIDIA Nemotron 3.5 Lightning · Free",
    tier: "free-tier" as const,
    supportsImages: false,
    expertise: ["general chat", "classification", "extraction", "summarization", "short drafting"] as const
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "NVIDIA Nemotron 3 Ultra 550B · Free",
    tier: "free-tier" as const,
    supportsImages: false,
    expertise: ["deep reasoning", "planning", "UX critique", "strategy"] as const
  },
  {
    id: "qwen/qwen3.8-27b:free",
    label: "Qwen 3.8 27B · Free · Vision + Code",
    tier: "free-tier" as const,
    supportsImages: true,
    expertise: ["visual screen audits", "multimodal understanding", "coding", "UX critique", "research synthesis"] as const
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "NVIDIA Nemotron Nano Omni · Free · Vision",
    tier: "free-tier" as const,
    supportsImages: true,
    expertise: ["screenshot analysis", "image understanding", "multimodal reasoning", "summarization"] as const
  }
] as const;

export const OPENROUTER_PAID_CHAT_MODELS = [
  {
    id: "openai/gpt-oss-20b",
    label: "OpenAI GPT-OSS 20B · Low-cost",
    tier: "paid" as const,
    supportsImages: false,
    expertise: ["routine coding", "debugging", "classification", "extraction", "fast drafts", "UX writing"] as const,
    listedInputUsdPerMillion: 0.02,
    listedOutputUsdPerMillion: 0.10,
    budgetInputUsdPerMillion: 0.10,
    budgetOutputUsdPerMillion: 0.50,
    pricingSource: "https://openrouter.ai/openai/gpt-oss-20b/pricing"
  },
  {
    id: "openai/gpt-oss-120b",
    label: "OpenAI GPT-OSS 120B · Reasoning",
    tier: "paid" as const,
    supportsImages: false,
    expertise: ["UX critique", "user journeys", "information architecture", "planning", "reasoning", "research synthesis", "structured output"] as const,
    listedInputUsdPerMillion: 0.03,
    listedOutputUsdPerMillion: 0.17,
    budgetInputUsdPerMillion: 0.15,
    budgetOutputUsdPerMillion: 0.85,
    pricingSource: "https://openrouter.ai/openai/gpt-oss-120b"
  },
  {
    id: "openai/gpt-6-luna",
    label: "OpenAI GPT-6 Luna · Paid · Vision",
    tier: "paid" as const,
    supportsImages: true,
    expertise: ["general UX conversation", "UX writing", "stakeholder communication", "classification", "fast drafting", "visual screen audit"] as const,
    listedInputUsdPerMillion: 0.10,
    listedOutputUsdPerMillion: 0.50,
    budgetInputUsdPerMillion: 0.50,
    budgetOutputUsdPerMillion: 2.50,
    pricingSource: "https://openrouter.ai/openai/gpt-6-luna"
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 · Coding",
    tier: "paid" as const,
    supportsImages: false,
    expertise: ["complex code", "debugging", "TypeScript", "implementation planning", "agent workflows", "technical design systems"] as const,
    listedInputUsdPerMillion: 0.03,
    listedOutputUsdPerMillion: 0.13,
    budgetInputUsdPerMillion: 0.15,
    budgetOutputUsdPerMillion: 0.65,
    pricingSource: "https://openrouter.ai/deepseek/deepseek-v4-flash-0731"
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash · Advanced reasoning",
    tier: "paid" as const,
    supportsImages: true,
    expertise: ["complex reasoning", "advanced UX strategy", "complex journeys", "IA", "critique", "research synthesis"] as const,
    listedInputUsdPerMillion: 0.30,
    listedOutputUsdPerMillion: 1.20,
    budgetInputUsdPerMillion: 0.65,
    budgetOutputUsdPerMillion: 2.60,
    pricingSource: "https://openrouter.ai/deepseek/deepseek-v4.1-flash"
  }
] as const;

export type OpenRouterFreeChatModel = (typeof OPENROUTER_FREE_CHAT_MODELS)[number];
export type OpenRouterPaidChatModel = (typeof OPENROUTER_PAID_CHAT_MODELS)[number];

export function getOpenRouterFreeChatModel(modelId: string): OpenRouterFreeChatModel | undefined {
  return OPENROUTER_FREE_CHAT_MODELS.find(model => model.id === modelId);
}

export function getOpenRouterPaidChatModel(modelId: string): OpenRouterPaidChatModel | undefined {
  return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === modelId);
}

/** Pick the least-expensive approved image-capable model for a needed vision substitution. */
export function selectOpenRouterPaidVisionModel(): OpenRouterPaidChatModel {
  return [...OPENROUTER_PAID_CHAT_MODELS]
    .filter(model => model.supportsImages)
    .sort((left, right) =>
      (left.listedInputUsdPerMillion * 0.25 + left.listedOutputUsdPerMillion) -
      (right.listedInputUsdPerMillion * 0.25 + right.listedOutputUsdPerMillion)
    )[0]!;
}

/** Choose a low-cost paid expertise match from the latest user message; no classifier call is needed. */
export function selectOpenRouterPaidChatModel(
  messages: Array<{ role: string; content: string }>
): OpenRouterPaidChatModel {
  const lastUserMessage = [...messages].reverse().find(message => message.role === "user")?.content ?? "";
  const prompt = lastUserMessage.toLowerCase();

  if (/\b(plugin architecture|agent workflow|multi[- ]file|repository[- ]level|large codebase|technical architecture|complex implementation|production architecture)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "deepseek/deepseek-v4-flash-0731")!;
  }

  if (/\b(complex reasoning|deep reasoning|high-stakes|complex trade[- ]off|advanced product strategy|root cause analysis)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "deepseek/deepseek-v4.1-flash")!;
  }

  if (/\b(strategy|strategic|critique|audit|heuristic|information architecture|\bia\b|user journey|journey map|flow design|research synthesis|accessibility review|product direction|decision framework)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "openai/gpt-oss-120b")!;
  }

  if (/\b(ux writing|stakeholder communication|stakeholder update|presentation|polish|brand voice|client-facing copy)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "openai/gpt-6-luna")!;
  }

  if (/\b(code|coding|debug|bug|typescript|javascript|react|next\.js|api route|endpoint|build error|stack trace|implementation|deploy|webpack)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "openai/gpt-oss-20b")!;
  }

  return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "openai/gpt-oss-20b")!;
}
