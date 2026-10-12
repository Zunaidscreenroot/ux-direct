/**
 * Explicit model pool for the UX Direct Figma cockpit.
 * These IDs are the only OpenRouter models exposed by the cockpit.
 * Price display values are informational; conservative budget rates are
 * deliberately higher than expected listed rates.
 */
export const OPENROUTER_FREE_CHAT_MODELS = [
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "NVIDIA Nemotron 3.5 Lightning · Free",
    tier: "free-tier" as const,
    expertise: ["general chat", "classification", "extraction", "summarization", "short drafting"] as const
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "NVIDIA Nemotron 3 Ultra 550B · Free",
    tier: "free-tier" as const,
    expertise: ["deep reasoning", "planning", "UX critique", "strategy"] as const
  }
] as const;

export const OPENROUTER_PAID_CHAT_MODELS = [
  {
    id: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash · Paid",
    tier: "paid" as const,
    supportsImages: true,
    expertise: ["complex reasoning", "UX strategy", "journeys", "IA", "critique", "research synthesis"] as const,
    listedInputUsdPerMillion: 0.13,
    listedOutputUsdPerMillion: 0.52,
    budgetInputUsdPerMillion: 0.65,
    budgetOutputUsdPerMillion: 2.60,
    pricingSource: "https://openrouter.ai/deepseek/deepseek-v4.1-flash"
  },
  {
    id: "openai/gpt-6-luna",
    label: "OpenAI GPT-6 Luna · Paid",
    tier: "paid" as const,
    supportsImages: true,
    expertise: ["general UX conversation", "UX writing", "stakeholder communication", "classification", "fast drafting"] as const,
    listedInputUsdPerMillion: 0.10,
    listedOutputUsdPerMillion: 0.50,
    budgetInputUsdPerMillion: 0.50,
    budgetOutputUsdPerMillion: 2.50,
    pricingSource: "https://openrouter.ai/openai/gpt-6-luna"
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731 · Paid",
    tier: "paid" as const,
    supportsImages: false,
    expertise: ["code", "debugging", "TypeScript", "implementation planning", "agent workflows", "technical design systems"] as const,
    listedInputUsdPerMillion: 0.03,
    listedOutputUsdPerMillion: 1.28,
    budgetInputUsdPerMillion: 0.15,
    budgetOutputUsdPerMillion: 6.40,
    pricingSource: "https://openrouter.ai/deepseek/deepseek-v4-flash-0731"
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

/** Choose paid expertise from the latest user message only; no model-based classifier call is needed. */
export function selectOpenRouterPaidChatModel(
  messages: Array<{ role: string; content: string }>
): OpenRouterPaidChatModel {
  const lastUserMessage = [...messages].reverse().find(message => message.role === "user")?.content ?? "";
  const prompt = lastUserMessage.toLowerCase();

  if (/\b(code|coding|debug|bug|typescript|javascript|react|next\.js|api route|endpoint|build error|stack trace|implementation|deploy|webpack|plugin architecture|agent workflow|technical architecture)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "deepseek/deepseek-v4-flash-0731")!;
  }

  if (/\b(strategy|strategic|complex reasoning|deep reasoning|critique|audit|heuristic|information architecture|\bia\b|user journey|journey map|flow design|trade[- ]off|research synthesis|accessibility review|product direction|decision framework|root cause)\b/i.test(prompt)) {
    return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "deepseek/deepseek-v4.1-flash")!;
  }

  return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === "openai/gpt-6-luna")!;
}
