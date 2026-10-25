import { randomUUID } from "node:crypto";

export type GatewayMode = "free" | "paid" | "local" | "mock";
export type ModulePolicy = { enabled: boolean; mode: GatewayMode; selectedModelKey: string; monthlyBudgetInr: number; maxRequestCostInr: number; allowFallback: boolean };
export type ModelPolicy = { monthlyBudgetInr: number; maxRequestCostInr: number; inputPriceInrPerMillion: number; outputPriceInrPerMillion: number };
export type GatewaySettings = { version: 1; globalMonthlyBudgetInr: number; usdToInrRate: number; paidRoutingEnabled: boolean; modules: Record<string, ModulePolicy>; models: Record<string, ModelPolicy>; updatedAt?: string };
export const GATEWAY_MODULES = [
  { id: "reasoning", label: "Reasoning & task planning", description: "FreeLLMAPI-managed routing for internal product workflows.", alias: "uxd/reasoning", tasks: ["reasoning", "task planning", "analysis"], suggestedBudgetShare: 180 },
  { id: "classification", label: "Classification", description: "Classify and route internal work through FreeLLMAPI's configured router.", alias: "uxd/classify", tasks: ["classification", "intent", "routing"], suggestedBudgetShare: 80 },
  { id: "extraction", label: "Structured extraction", description: "Extract fields, requirements, rules and entities.", alias: "uxd/extract", tasks: ["extraction", "structured output", "requirements"], suggestedBudgetShare: 80 },
  { id: "summarization", label: "Summarization", description: "Summarize briefs, notes, research and references.", alias: "uxd/summarize", tasks: ["summaries", "summarization", "long context"], suggestedBudgetShare: 80 },
  { id: "vision", label: "Visual / screen analysis", description: "Interpret screenshots, UI states and visual references.", alias: "uxd/vision", tasks: ["vision", "visual analysis", "screenshots"], suggestedBudgetShare: 100 },
  { id: "critique", label: "UX critique & quality review", description: "Review UX decisions, accessibility, edge cases and consistency.", alias: "uxd/critique", tasks: ["critique", "reasoning", "quality"], suggestedBudgetShare: 120 },
  { id: "ia-audit", label: "IA architecture review", description: "Evidence-backed analysis of sitemap structure and findability risks, routed by FreeLLMAPI.", alias: "uxd/ia-audit", tasks: ["information architecture", "reasoning", "structured output"], suggestedBudgetShare: 250 },
  { id: "general", label: "General gateway calls", description: "Reserved for the homepage chat through the configured FreeLLMAPI router.", alias: "direct", tasks: ["general", "chat"], suggestedBudgetShare: 50 }
] as const;
type BlobStore = { get(key: string, options: { type: "json" }): Promise<unknown>; setJSON(key: string, value: unknown): Promise<void> };
const runtimeSettings = new Map<string, GatewaySettings>();
let storePromise: Promise<BlobStore | null> | null = null;
function amount(value: unknown, fallback: number, max = 1_000_000_000): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Number(n.toFixed(4))) : fallback;
}
export function modelKey(provider: string, id: string) { return provider + "::" + id; }
function envScopeKey(env = process.env) {
  const branch = env.NETLIFY_BRANCH || env.BRANCH || "";
  if (env.CONTEXT === "production" || (env.NETLIFY === "true" && branch === "main")) return "gateway-control:production";
  return "gateway-control:preview:" + (branch || env.CONTEXT || "local").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
}
async function getStore(): Promise<BlobStore | null> {
  if (process.env.NETLIFY !== "true" && !process.env.NETLIFY_BLOBS_CONTEXT) return null;
  if (!storePromise) storePromise = (async () => {
    try {
      const { getStore } = await import("@netlify/blobs");
      // Branch-prefixed keys below isolate preview settings from production settings.
      return getStore("ux-direct-gateway-control") as unknown as BlobStore;
    } catch { return null; }
  })();
  return storePromise;
}
function pricePolicy(inputUsd = 0, outputUsd = 0, fx = 97): ModelPolicy {
  return { monthlyBudgetInr: 0, maxRequestCostInr: 0, inputPriceInrPerMillion: Number((inputUsd * fx).toFixed(4)), outputPriceInrPerMillion: Number((outputUsd * fx).toFixed(4)) };
}
export function defaultGatewaySettings(): GatewaySettings {
  const modules: Record<string, ModulePolicy> = {};
  const autoRouterKey = modelKey("freellmapi", "auto");
  const testMode = process.env.NODE_ENV === "test";
  for (const m of GATEWAY_MODULES) {
    modules[m.id] = {
      enabled: true,
      mode: testMode ? "free" : "paid",
      // Internal work uses FreeLLMAPI Auto router; homepage chat uses the same FreeLLMAPI gateway.
      selectedModelKey: !testMode && m.id !== "general" ? autoRouterKey : "auto",
      monthlyBudgetInr: 0,
      maxRequestCostInr: 0,
      allowFallback: false
    };
  }
  const models: Record<string, ModelPolicy> = {
    [modelKey("gemini", "gemini-3.8-flash")]: pricePolicy(.75, 3.75),
    [modelKey("gemini", "gemini-3.5-flash")]: pricePolicy(1.5, 9),
    [modelKey("gemini", "gemini-3-flash-preview")]: pricePolicy(.5, 3),
    [modelKey("gemini", "gemini-3.1-flash-lite")]: pricePolicy(.25, 1.5),
    [modelKey("gemini", "gemini-2.5-flash")]: pricePolicy(.3, 2.5),
    [modelKey("gemini", "gemini-2.5-flash-lite")]: pricePolicy(.1, .4),
    [modelKey("groq", "openai/gpt-oss-120b")]: pricePolicy(.15, .6),
    [modelKey("groq", "openai/gpt-oss-20b")]: pricePolicy(.075, .3),
    [modelKey("deepseek", "deepseek-flash")]: pricePolicy(.30, 1.20),
    [modelKey("deepseek", "deepseek-v4-pro")]: pricePolicy(1.32, 3.96),
    [modelKey("freellmapi", "auto")]: pricePolicy(),
    [modelKey("ollama", "qwen2.5:7b")]: pricePolicy(),
    [modelKey("ollama", "gemma4:31b")]: pricePolicy(),
    [modelKey("cerebras", "gpt-oss-120b")]: pricePolicy(),
    [modelKey("openai", "gpt-4o-mini")]: pricePolicy(.15, .6)
  };
  const autoRouterConfigured = Boolean(process.env.FREELLMAPI_BASE_URL?.trim() && process.env.FREELLMAPI_API_KEY?.trim());
  return {
    version: 1,
    globalMonthlyBudgetInr: Math.min(1_000_000_000, Math.max(0, Number(process.env.MODEL_GATEWAY_MONTHLY_BUDGET_INR) || 0)),
    usdToInrRate: 97,
    paidRoutingEnabled: Boolean(autoRouterConfigured),
    modules,
    models
  };
}
function cleanSettings(input: unknown): GatewaySettings {
  const defaults = defaultGatewaySettings();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawModules = raw.modules && typeof raw.modules === "object" ? raw.modules as Record<string, unknown> : {};
  const rawModels = raw.models && typeof raw.models === "object" ? raw.models as Record<string, unknown> : {};
  const modules: Record<string, ModulePolicy> = {};
  for (const m of GATEWAY_MODULES) {
    const base = defaults.modules[m.id];
    const c = rawModules[m.id] && typeof rawModules[m.id] === "object" ? rawModules[m.id] as Record<string, unknown> : {};
    const mode = c.mode;
    const requestedModelKey = typeof c.selectedModelKey === "string" && c.selectedModelKey.length <= 220 ? c.selectedModelKey : base.selectedModelKey;
    modules[m.id] = {
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
      // Production internal modules use the configured FreeLLMAPI router; tests/dev may exercise other modes.
      mode: process.env.NODE_ENV === "production" ? "paid" :
        (mode === "free" || mode === "paid" || mode === "local" || mode === "mock" ? mode : base.mode),
      // Migrate the previous OpenRouter Auto selection to FreeLLMAPI Auto.
      selectedModelKey: (requestedModelKey.startsWith("openrouter-auto::") || requestedModelKey.startsWith("openrouter::") || requestedModelKey.startsWith("openrouter-paid::")) ? base.selectedModelKey : requestedModelKey,
      monthlyBudgetInr: amount(c.monthlyBudgetInr, base.monthlyBudgetInr),
      maxRequestCostInr: amount(c.maxRequestCostInr, base.maxRequestCostInr),
      allowFallback: typeof c.allowFallback === "boolean" ? c.allowFallback : base.allowFallback
    };
  }
  const models: Record<string, ModelPolicy> = { ...defaults.models };
  for (const [key, value] of Object.entries(rawModels)) {
    if (!/^[a-z0-9._-]{1,60}::[a-zA-Z0-9._:/-]{1,160}$/.test(key) || !value || typeof value !== "object") continue;
    const c = value as Record<string, unknown>;
    const base = models[key] ?? pricePolicy();
    models[key] = {
      monthlyBudgetInr: amount(c.monthlyBudgetInr, base.monthlyBudgetInr),
      maxRequestCostInr: amount(c.maxRequestCostInr, base.maxRequestCostInr),
      inputPriceInrPerMillion: amount(c.inputPriceInrPerMillion, base.inputPriceInrPerMillion),
      outputPriceInrPerMillion: amount(c.outputPriceInrPerMillion, base.outputPriceInrPerMillion)
    };
  }
  return {
    version: 1,
    globalMonthlyBudgetInr: amount(raw.globalMonthlyBudgetInr, defaults.globalMonthlyBudgetInr),
    usdToInrRate: Math.min(250, Math.max(1, amount(raw.usdToInrRate, 97))),
    paidRoutingEnabled: defaults.paidRoutingEnabled || raw.paidRoutingEnabled === true,
    modules, models, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined
  };
}
export async function getGatewaySettings(): Promise<GatewaySettings> {
  const key = envScopeKey();
  const store = await getStore();
  if (store) {
    try {
      const value = await store.get(key, { type: "json" });
      if (value && typeof value === "object") {
        const settings = cleanSettings(value);
        runtimeSettings.set(key, settings);
        return settings;
      }
    } catch { /* runtime fallback */ }
  }
  return cleanSettings(runtimeSettings.get(key) ?? defaultGatewaySettings());
}
export async function saveGatewaySettings(input: unknown): Promise<GatewaySettings> {
  const key = envScopeKey();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const settings = cleanSettings({ ...raw, updatedAt: new Date().toISOString() });
  runtimeSettings.set(key, settings);
  const store = await getStore();
  if (store) {
    try { await store.setJSON(key, settings); }
    catch (error) { throw new Error("Could not persist gateway settings to Netlify Blobs: " + (error instanceof Error ? error.message : "unknown error")); }
  }
  return settings;
}
export function getDefaultModelPolicy(provider: string, id: string, inputUsd = 0, outputUsd = 0, fx = 97): ModelPolicy {
  const defaults = defaultGatewaySettings();
  return defaults.models[modelKey(provider, id)] ?? pricePolicy(inputUsd, outputUsd, fx);
}
export function newControlRequestId() { return randomUUID(); }
