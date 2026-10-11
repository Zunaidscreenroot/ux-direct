/**
 * Small, explicit OpenRouter paid-model allowlist for live cockpit testing.
 * The displayed upstream list price is informational; budget checks deliberately
 * reserve at 5x that price to account for provider pricing variability.
 */
export const OPENROUTER_PAID_CHAT_MODELS = [
  {
    id: "openai/gpt-oss-20b",
    label: "OpenAI GPT OSS 20B · Paid",
    tier: "paid" as const,
    listedInputUsdPerMillion: 0.02,
    listedOutputUsdPerMillion: 0.10,
    budgetInputUsdPerMillion: 0.10,
    budgetOutputUsdPerMillion: 0.50,
    pricingSource: "https://openrouter.ai/openai/gpt-oss-20b/pricing"
  }
] as const;

export type OpenRouterPaidChatModel = (typeof OPENROUTER_PAID_CHAT_MODELS)[number];

export function getOpenRouterPaidChatModel(modelId: string): OpenRouterPaidChatModel | undefined {
  return OPENROUTER_PAID_CHAT_MODELS.find(model => model.id === modelId);
}
