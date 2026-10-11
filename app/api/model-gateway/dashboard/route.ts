import { NextResponse } from "next/server";
import { getModelCatalog, providersFromEnv } from "@/src/model-gateway";
import { getLiveGatewayModels, getOpenRouterUsageSnapshot } from "@/src/model-gateway/openrouter-catalog";
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
  const staticCatalog = getModelCatalog(providers);
  let catalog = staticCatalog.filter(model => model.provider === "mock");
  let openRouterCatalog = { status: "not-configured", modelCount: 0, checkedAt: null as string | null, error: undefined as string | undefined };
  if (env.OPENROUTER_API_KEY) {
    try {
      const live = await getLiveGatewayModels();
      catalog = [...catalog, ...live.models];
      openRouterCatalog = { status: "live", modelCount: live.models.length, checkedAt: live.checkedAt, error: undefined };
    } catch (error) {
      const stale = staticCatalog.filter(model => model.provider === "openrouter");
      catalog = [...catalog, ...stale];
      openRouterCatalog = { status: "error", modelCount: stale.length, checkedAt: null, error: error instanceof Error ? error.message : "OpenRouter catalog unavailable." };
    }
  }
  const openRouterUsage = await getOpenRouterUsageSnapshot();
  const modelSettings = { ...settings.models };
  for (const model of catalog) {
    const key = modelKey(model.provider, model.id);
    if (!modelSettings[key]) modelSettings[key] = getDefaultModelPolicy(model.provider, model.id, model.usdInputPerMillion ?? 0, model.usdOutputPerMillion ?? 0, settings.usdToInrRate);
  }
  const validModelKeys = new Set(catalog.map(model => modelKey(model.provider, model.id)));
  const modules = Object.fromEntries(Object.entries(settings.modules).map(([id, policy]) => {
    const stillListed = policy.selectedModelKey === "auto" || validModelKeys.has(policy.selectedModelKey);
    const mode = policy.mode === "local" || policy.mode === "mock" ? "free" : policy.mode;
    return [id, { ...policy, mode, selectedModelKey: stillListed ? policy.selectedModelKey : "auto" }];
  })) as typeof settings.modules;
  const fullSettings = { ...settings, modules, models: modelSettings };
  const keySlots = [
    { id: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY", configured: Boolean(env.OPENROUTER_API_KEY), keyDetected: Boolean(env.OPENROUTER_API_KEY), tier: "unified-model-catalog", secretRequired: true },
  ];
  return NextResponse.json({
    gateway: {
      name: "UX Direct Model Gateway",
      status: env.OPENROUTER_API_KEY ? "openrouter-configured" : "awaiting-openrouter-key",
      paidModelsEnabled: fullSettings.paidRoutingEnabled && env.ALLOW_PAID_MODELS === "true",
      monthlyBudgetInr: budget.monthlyBudgetInr,
      pricingConfigured: budget.pricingConfigured,
      gatewayFeeInr: 0
    },
    providers: keySlots,
    models: catalog.map(model => ({ ...model, selectionKey: modelKey(model.provider, model.id) })),
    openRouterCatalog,
    openRouterUsage,
    settings: fullSettings,
    modules: GATEWAY_MODULES,
    budget,
    checkedAt: new Date().toISOString()
  }, { headers: { "Cache-Control": "no-store" } });
}
