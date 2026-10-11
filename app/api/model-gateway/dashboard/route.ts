import { NextResponse } from "next/server";
import { getModelCatalog, providersFromEnv } from "@/src/model-gateway";
import { GATEWAY_MODULES, getGatewaySettings, getDefaultModelPolicy, modelKey } from "@/src/model-gateway/control-store";
import { getBudgetSnapshot } from "@/src/model-gateway/usage-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only dashboard data only. Never return API keys, auth headers, or full secret values.
export async function GET() {
  const env = process.env;
  const providers = providersFromEnv();
  const budget = await getBudgetSnapshot();
  const configuredProviders = new Set(providers.map(provider => provider.name));
  const settings = await getGatewaySettings();
  const catalog = getModelCatalog(providers);
  const modelSettings = { ...settings.models };
  for (const model of catalog) {
    const key = modelKey(model.provider, model.id);
    if (!modelSettings[key]) modelSettings[key] = getDefaultModelPolicy(model.provider, model.id, model.usdInputPerMillion ?? 0, model.usdOutputPerMillion ?? 0, settings.usdToInrRate);
  }
  const fullSettings = { ...settings, models: modelSettings };
  const keySlots = [
    { id: "ollama", label: "Ollama local", envName: "OLLAMA_BASE_URL", configured: configuredProviders.has("ollama"), keyDetected: false, tier: "local", secretRequired: false },
    { id: "gemini", label: "Google Gemini", envName: "GEMINI_API_KEY", configured: configuredProviders.has("gemini"), keyDetected: Boolean(env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY), tier: env.GEMINI_BILLING_MODE === "paid" ? "paid" : "free-tier", secretRequired: true },
    { id: "groq", label: "Groq", envName: "GROQ_API_KEY", configured: configuredProviders.has("groq"), keyDetected: Boolean(env.GROQ_API_KEY), tier: env.GROQ_BILLING_MODE === "paid" ? "paid" : "free-tier", secretRequired: true },
    { id: "cerebras", label: "Cerebras", envName: "CEREBRAS_API_KEY", configured: configuredProviders.has("cerebras"), keyDetected: Boolean(env.CEREBRAS_API_KEY), tier: env.CEREBRAS_BILLING_MODE === "paid" ? "paid" : "free-tier", secretRequired: true },
    { id: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY", configured: configuredProviders.has("openrouter"), keyDetected: Boolean(env.OPENROUTER_API_KEY), tier: "free-tier", secretRequired: true },
    { id: "openai", label: "OpenAI (paid)", envName: "OPENAI_API_KEY", configured: configuredProviders.has("openai"), keyDetected: Boolean(env.OPENAI_API_KEY), tier: "paid", secretRequired: true },
    { id: "deepseek", label: "DeepSeek (paid)", envName: "DEEPSEEK_API_KEY", configured: configuredProviders.has("deepseek"), keyDetected: Boolean(env.DEEPSEEK_API_KEY), tier: "paid", secretRequired: true },
  ];
  return NextResponse.json({
    gateway: {
      name: "UX Direct Model Gateway",
      status: providers.some(provider => provider.kind !== "mock") ? "provider-configured" : "awaiting-keys",
      paidModelsEnabled: fullSettings.paidRoutingEnabled && env.ALLOW_PAID_MODELS === "true",
      monthlyBudgetInr: budget.monthlyBudgetInr,
      pricingConfigured: budget.pricingConfigured,
      gatewayFeeInr: 0
    },
    providers: keySlots,
    models: catalog.map(model => ({ ...model, selectionKey: modelKey(model.provider, model.id) })),
    settings: fullSettings,
    modules: GATEWAY_MODULES,
    budget,
    checkedAt: new Date().toISOString()
  }, { headers: { "Cache-Control": "no-store" } });
}
