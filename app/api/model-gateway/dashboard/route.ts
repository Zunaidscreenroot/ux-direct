import { NextResponse } from "next/server";
import { getModelCatalog, providersFromEnv } from "@/src/model-gateway";
import { getBudgetSnapshot } from "@/src/model-gateway/usage-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only dashboard data only. Never return API keys, auth headers, or full secret values.
export async function GET() {
  const env = process.env;
  const providers = providersFromEnv();
  const budget = getBudgetSnapshot();
  const configuredProviders = new Set(providers.map(provider => provider.name));
  const keySlots = [
    { id: "ollama", label: "Ollama local", envName: "OLLAMA_BASE_URL", configured: configuredProviders.has("ollama"), keyDetected: false, tier: "local", secretRequired: false },
    { id: "gemini", label: "Google Gemini", envName: "GEMINI_API_KEY", configured: configuredProviders.has("gemini"), keyDetected: Boolean(env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY), tier: "free-tier", secretRequired: true },
    { id: "groq", label: "Groq", envName: "GROQ_API_KEY", configured: configuredProviders.has("groq"), keyDetected: Boolean(env.GROQ_API_KEY), tier: "free-tier", secretRequired: true },
    { id: "cerebras", label: "Cerebras", envName: "CEREBRAS_API_KEY", configured: configuredProviders.has("cerebras"), keyDetected: Boolean(env.CEREBRAS_API_KEY), tier: "free-tier", secretRequired: true },
    { id: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY", configured: configuredProviders.has("openrouter"), keyDetected: Boolean(env.OPENROUTER_API_KEY), tier: "free-tier", secretRequired: true },
    { id: "openai", label: "OpenAI (paid)", envName: "OPENAI_API_KEY", configured: configuredProviders.has("openai"), keyDetected: Boolean(env.OPENAI_API_KEY), tier: "paid", secretRequired: true },
  ];
  return NextResponse.json({
    gateway: {
      name: "UX Direct Model Gateway",
      status: providers.some(provider => provider.kind !== "mock") ? "provider-configured" : "awaiting-keys",
      paidModelsEnabled: providers.some(provider => provider.kind === "paid") && env.ALLOW_PAID_MODELS === "true" && budget.pricingConfigured,
      monthlyBudgetInr: budget.monthlyBudgetInr,
      pricingConfigured: budget.pricingConfigured,
      gatewayFeeInr: 0
    },
    providers: keySlots,
    models: getModelCatalog(providers),
    budget,
    checkedAt: new Date().toISOString()
  }, { headers: { "Cache-Control": "no-store" } });
}
