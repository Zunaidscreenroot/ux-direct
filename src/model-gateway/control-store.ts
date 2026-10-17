import { randomUUID } from "node:crypto";
import { isVercelBlobConfigured, readBlobJson, writeBlobJson } from "@/src/storage/vercel-blob-json";

export type GatewayMode = "free" | "paid" | "local" | "mock";
export type ModulePolicy = { enabled: boolean; mode: GatewayMode; selectedModelKey: string; monthlyBudgetInr: number; maxRequestCostInr: number; allowFallback: boolean };
export type ModelPolicy = { monthlyBudgetInr: number; maxRequestCostInr: number; inputPriceInrPerMillion: number; outputPriceInrPerMillion: number };
export type GatewaySettings = { version: 1; globalMonthlyBudgetInr: number; usdToInrRate: number; paidRoutingEnabled: boolean; modules: Record<string, ModulePolicy>; models: Record<string, ModelPolicy>; updatedAt?: string };
export const GATEWAY_MODULES = [
  { id: "reasoning", label: "Reasoning & task planning", description: "Multi-step UX decisions, task plans and complex trade-offs.", alias: "uxd/reasoning", tasks: ["reasoning", "task planning", "analysis"], suggestedBudgetShare: 1000 },
  { id: "classification", label: "Classification", description: "Route requests, identify intent and classify design work.", alias: "uxd/classify", tasks: ["classification", "intent", "routing"], suggestedBudgetShare: 250 },
  { id: "extraction", label: "Structured extraction", description: "Extract fields, requirements, rules and entities into structured output.", alias: "uxd/extract", tasks: ["extraction", "structured output", "requirements"], suggestedBudgetShare: 250 },
  { id: "summarization", label: "Summarization", description: "Summarize briefs, long notes, research and design references.", alias: "uxd/summarize", tasks: ["summaries", "summarization", "long context"], suggestedBudgetShare: 300 },
  { id: "vision", label: "Visual / screen analysis", description: "Interpret screenshots, UI states and visual references.", alias: "uxd/vision", tasks: ["vision", "visual analysis", "screenshots"], suggestedBudgetShare: 600 },
  { id: "critique", label: "UX critique & quality review", description: "Review UX decisions, accessibility, edge cases and consistency.", alias: "uxd/critique", tasks: ["critique", "reasoning", "quality"], suggestedBudgetShare: 500 },
  { id: "general", label: "General gateway calls", description: "Direct model calls without a more specific agent purpose.", alias: "direct", tasks: ["general", "chat"], suggestedBudgetShare: 100 }
] as const;
const runtimeSettings = new Map<string, GatewaySettings>();
function amount(value: unknown, fallback: number, max = 1_000_000_000): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Number(n.toFixed(4))) : fallback;
}
export function modelKey(provider: string, id: string) { return provider + "::" + id; }
function envScopeKey(env = process.env) {
  const branch = env.VERCEL_GIT_COMMIT_REF || env.BRANCH || "";
  if (env.VERCEL_ENV === "production") return "ux-direct-gateway-control/production";
  return "ux-direct-gateway-control/preview/" +
    (branch || env.VERCEL_ENV || "local").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
}
function pricePolicy(inputUsd = 0, outputUsd = 0, fx = 97): ModelPolicy {
  return { monthlyBudgetInr: 500, maxRequestCostInr: 50, inputPriceInrPerMillion: Number((inputUsd * fx).toFixed(4)), outputPriceInrPerMillion: Number((outputUsd * fx).toFixed(4)) };
}
export function defaultGatewaySettings(): GatewaySettings {
  const modules: Record<string, ModulePolicy> = {};
  for (const m of GATEWAY_MODULES) modules[m.id] = { enabled: true, mode: "free", selectedModelKey: m.id === "reasoning" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) ? modelKey("gemini", "gemini-3.5-flash-lite") : "auto", monthlyBudgetInr: m.suggestedBudgetShare, maxRequestCostInr: 10, allowFallback: m.id === "reasoning" };
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
    [modelKey("openrouter", "apodex/apodex-1.1-mini:free")]: pricePolicy(),
    [modelKey("ollama", "qwen2.5:7b")]: pricePolicy(),
    [modelKey("ollama", "gemma4:31b")]: pricePolicy(),
    [modelKey("cerebras", "gpt-oss-120b")]: pricePolicy(),
    [modelKey("openai", "gpt-4o-mini")]: pricePolicy(.15, .6)
  };
  return { version: 1, globalMonthlyBudgetInr: 3000, usdToInrRate: 97, paidRoutingEnabled: false, modules, models };
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
    modules[m.id] = {
      enabled: typeof c.enabled === "boolean" ? c.enabled : true,
      mode: mode === "free" || mode === "paid" || mode === "local" || mode === "mock" ? mode : base.mode,
      selectedModelKey: typeof c.selectedModelKey === "string" && c.selectedModelKey.length <= 220 ? c.selectedModelKey : base.selectedModelKey,
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
    paidRoutingEnabled: typeof raw.paidRoutingEnabled === "boolean" ? raw.paidRoutingEnabled : false,
    modules, models, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined
  };
}
export async function getGatewaySettings(): Promise<GatewaySettings> {
  const key = envScopeKey();
  if (isVercelBlobConfigured()) try {
    const value = await readBlobJson<unknown>(key);
    if (value && typeof value === "object") {
      const settings = cleanSettings(value);
      runtimeSettings.set(key, settings);
      return settings;
    }
  } catch { /* runtime fallback */ }
  return cleanSettings(runtimeSettings.get(key) ?? defaultGatewaySettings());
}
export async function saveGatewaySettings(input: unknown): Promise<GatewaySettings> {
  const key = envScopeKey();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const settings = cleanSettings({ ...raw, updatedAt: new Date().toISOString() });
  runtimeSettings.set(key, settings);
  if (isVercelBlobConfigured()) {
    try {
      await writeBlobJson(key, settings);
    } catch (error) {
      throw new Error("Could not persist gateway settings to Vercel Blob: " + (error instanceof Error ? error.message : "unknown error"));
    }
  }
  return settings;
}
export function getDefaultModelPolicy(provider: string, id: string, inputUsd = 0, outputUsd = 0, fx = 97): ModelPolicy {
  const defaults = defaultGatewaySettings();
  return defaults.models[modelKey(provider, id)] ?? pricePolicy(inputUsd, outputUsd, fx);
}
export function newControlRequestId() { return randomUUID(); }
