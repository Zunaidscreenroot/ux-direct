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
  const allowedModelKeys = new Set(catalog.map(model => modelKey(model.provider, model.id)));
  // Remove legacy provider/model policies from the payload so they cannot be
  // reintroduced into the restricted cockpit when a user saves settings.
  const modelSettings = Object.fromEntries(
    Object.entries(settings.models).filter(([key]) => allowedModelKeys.has(key))
  ) as typeof settings.models;
  for (const model of catalog) {
    const key = modelKey(model.provider, model.id);
    if (!modelSettings[key]) modelSettings[key] = getDefaultModelPolicy(model.provider, model.id, model.usdInputPerMillion ?? 0, model.usdOutputPerMillion ?? 0, settings.usdToInrRate);
  }
  const fullSettings = { ...settings, models: modelSettings };
  const keySlots = [
    { id: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY", configured: configuredProviders.has("openrouter"), keyDetected: Boolean(env.OPENROUTER_API_KEY), tier: "free-tier", secretRequired: true }
  ];
  return NextResponse.json({
    gateway: {
      name: "UX Direct Model Gateway",
      status: providers.some(provider => provider.kind !== "mock") ? "provider-configured" : "awaiting-keys",
      paidModelsEnabled: Boolean(env.OPENROUTER_API_KEY),
      routingPolicy: "free-first; one expertise-selected paid model only after the two approved free models fail",
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
