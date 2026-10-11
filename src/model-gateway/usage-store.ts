import { randomUUID } from "node:crypto";
import type { ProviderConfig, TokenUsage } from "./index";
import { getGatewaySettings, modelKey } from "./control-store";

export type UsageRecord = {
  id: string;
  at: string;
  requestId: string;
  provider: string;
  model: string;
  moduleId?: string;
  tier: "local" | "free-tier" | "paid" | "mock";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageReported?: boolean;
  estimatedCostInr: number;
  latencyMs: number;
  status: "success" | "error" | "blocked";
  note?: string;
};

export type BudgetSnapshot = {
  currency: "INR";
  monthlyBudgetInr: number;
  spentThisMonthInr: number;
  remainingInr: number;
  percentUsed: number;
  inputPriceInrPerMillion: number;
  outputPriceInrPerMillion: number;
  pricingConfigured: boolean;
  month: string;
  records: UsageRecord[];
  retention: "netlify-blobs" | "best-effort-runtime";
  spentByModuleInr: Record<string, number>;
  spentByModelInr: Record<string, number>;
  paidCallsThisMonth: number;
};

const runtimeRecords: UsageRecord[] = [];
const MAX_RECORDS = 1000;
type LedgerStore = {
  get(key: string, options: { type: "json" }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<void>;
};
let storePromise: Promise<LedgerStore | null> | null = null;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
export function getBudgetConfig(env: Record<string, string | undefined> = process.env) {
  return {
    monthlyBudgetInr: positiveNumber(env.MODEL_GATEWAY_MONTHLY_BUDGET_INR, 3000),
    inputPriceInrPerMillion: positiveNumber(env.MODEL_GATEWAY_INPUT_PRICE_INR_PER_1M, 0),
    outputPriceInrPerMillion: positiveNumber(env.MODEL_GATEWAY_OUTPUT_PRICE_INR_PER_1M, 0),
  };
}
function scopedLedgerKey(env = process.env) {
  const branch = env.NETLIFY_BRANCH || env.BRANCH || "";
  if (env.CONTEXT === "production" || (env.NETLIFY === "true" && branch === "main")) return "usage-records";
  return "usage-records:preview:" + (branch || env.CONTEXT || "local").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
}
function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
async function getPersistentStore(): Promise<LedgerStore | null> {
  // Netlify Blobs is used only in the deployed Netlify runtime. Local tests/dev
  // remain dependency-free and use the runtime memory fallback.
  if (process.env.NETLIFY !== "true" && !process.env.NETLIFY_BLOBS_CONTEXT) return null;
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const { getStore } = await import("@netlify/blobs");
        return getStore("ux-direct-model-gateway-usage") as unknown as LedgerStore;
      } catch {
        return null;
      }
    })();
  }
  return storePromise;
}
async function readRecords(): Promise<{ records: UsageRecord[]; retention: BudgetSnapshot["retention"]; store: LedgerStore | null }> {
  const store = await getPersistentStore();
  if (store) {
    try {
      const value = await store.get(scopedLedgerKey(), { type: "json" });
      const persisted = Array.isArray(value) ? value as UsageRecord[] : [];
      runtimeRecords.splice(0, runtimeRecords.length, ...persisted.slice(0, MAX_RECORDS));
      return { records: [...runtimeRecords], retention: "netlify-blobs", store };
    } catch {
      // Keep requests available during a temporary Blobs failure, but expose that
      // the ledger is now only best-effort in memory for this runtime.
    }
  }
  return { records: [...runtimeRecords], retention: "best-effort-runtime", store: null };
}
export function estimateCostInr(
  promptTokens: number,
  completionTokens: number,
  provider: ProviderConfig,
  env = process.env,
  model?: string,
  override?: { billable?: boolean; inputPriceInrPerMillion?: number; outputPriceInrPerMillion?: number }
) {
  if (model?.endsWith(":free") || override?.billable === false) return 0;
  if (override?.billable !== true && (provider.kind === "local" || provider.kind === "free-tier" || provider.kind === "mock")) return 0;
  const config = getBudgetConfig(env);
  return promptTokens * (override?.inputPriceInrPerMillion ?? config.inputPriceInrPerMillion) / 1_000_000 +
    completionTokens * (override?.outputPriceInrPerMillion ?? config.outputPriceInrPerMillion) / 1_000_000;
}
export async function recordModelUsage(input: Omit<UsageRecord, "id" | "at"> & { id?: string; at?: string }) {
  const item: UsageRecord = {
    ...input,
    id: input.id ?? randomUUID(),
    at: input.at ?? new Date().toISOString(),
    promptTokens: Math.max(0, Math.round(input.promptTokens)),
    completionTokens: Math.max(0, Math.round(input.completionTokens)),
    totalTokens: Math.max(0, Math.round(input.totalTokens)),
    estimatedCostInr: Math.max(0, Number(input.estimatedCostInr.toFixed(6))),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    requestId: input.requestId.slice(0, 100),
    provider: input.provider.slice(0, 60),
    model: input.model.slice(0, 160),
    moduleId: input.moduleId?.slice(0, 60),
    note: input.note?.slice(0, 240)
  };
  const { records, store } = await readRecords();
  const next = [item, ...records].slice(0, MAX_RECORDS);
  runtimeRecords.splice(0, runtimeRecords.length, ...next);
  if (store) {
    try { await store.setJSON(scopedLedgerKey(), next); }
    catch { /* The UI will report runtime-only retention if subsequent reads fail. */ }
  }
  // Structured logs never contain prompts, completions, or credentials.
  console.info("[model-gateway-usage]", JSON.stringify(item));
  return item;
}
export async function getBudgetSnapshot(env = process.env, now = new Date()): Promise<BudgetSnapshot> {
  const config = getBudgetConfig(env);
  const settings = env === process.env ? await getGatewaySettings() : null;
  const monthlyBudget = settings?.globalMonthlyBudgetInr ?? config.monthlyBudgetInr;
  const { records, retention } = await readRecords();
  const month = monthKey(now);
  const monthly = records.filter(item => item.at.slice(0, 7) === month);
  const paidMonthly = monthly.filter(item => item.tier === "paid");
  const spent = monthly.reduce((total, item) => total + item.estimatedCostInr, 0);
  const spentByModuleInr: Record<string, number> = {};
  const spentByModelInr: Record<string, number> = {};
  for (const item of monthly) {
    if (item.moduleId) spentByModuleInr[item.moduleId] = Number(((spentByModuleInr[item.moduleId] ?? 0) + item.estimatedCostInr).toFixed(6));
    const key = modelKey(item.provider, item.model);
    spentByModelInr[key] = Number(((spentByModelInr[key] ?? 0) + item.estimatedCostInr).toFixed(6));
  }
  const pricingConfigured = settings ? Object.values(settings.models).some(m => m.inputPriceInrPerMillion > 0 && m.outputPriceInrPerMillion > 0) :
    config.inputPriceInrPerMillion > 0 && config.outputPriceInrPerMillion > 0;
  return {
    currency: "INR", monthlyBudgetInr: monthlyBudget, spentThisMonthInr: Number(spent.toFixed(4)),
    remainingInr: Math.max(0, Number((monthlyBudget - spent).toFixed(4))),
    percentUsed: monthlyBudget > 0 ? Math.min(100, Number((spent / monthlyBudget * 100).toFixed(2))) : 100,
    inputPriceInrPerMillion: config.inputPriceInrPerMillion, outputPriceInrPerMillion: config.outputPriceInrPerMillion,
    pricingConfigured, month, records: monthly.slice(0, 200), retention, spentByModuleInr, spentByModelInr, paidCallsThisMonth: paidMonthly.length
  };
}

export async function assertBudgetAllows(
  promptChars: number, maxOutputTokens = 1024, env = process.env, model?: string,
  opts: { moduleId?: string; modelKey?: string; inputPriceInrPerMillion?: number; outputPriceInrPerMillion?: number; maxRequestCostInr?: number } = {}
) {
  const settings = env === process.env ? await getGatewaySettings() : null;
  const config = getBudgetConfig(env);
  const moduleId = opts.moduleId ?? "general";
  const modulePolicy = settings?.modules[moduleId];
  const modelPolicy = settings?.models[opts.modelKey ?? ""];
  const inputRate = opts.inputPriceInrPerMillion ?? modelPolicy?.inputPriceInrPerMillion ?? config.inputPriceInrPerMillion;
  const outputRate = opts.outputPriceInrPerMillion ?? modelPolicy?.outputPriceInrPerMillion ?? config.outputPriceInrPerMillion;
  if (!(inputRate > 0) || !(outputRate > 0)) throw Object.assign(new Error("Paid model requests are blocked until exact-model input and output prices are configured."), { status: 503 });
  const globalBudget = settings?.globalMonthlyBudgetInr ?? config.monthlyBudgetInr;
  if (globalBudget <= 0) throw Object.assign(new Error("Paid model requests are blocked because the global monthly budget is zero."), { status: 402 });
  const estimatedPromptTokens = Math.ceil(promptChars / 4);
  const reserve = estimatedPromptTokens * inputRate / 1_000_000 + maxOutputTokens * outputRate / 1_000_000;
  if (opts.maxRequestCostInr !== undefined && reserve > opts.maxRequestCostInr) throw Object.assign(new Error("Projected request exceeds this module/model per-request cap."), { status: 402 });
  const { records } = await readRecords();
  const month = monthKey();
  const monthly = records.filter(item => item.at.slice(0, 7) === month && item.tier === "paid");
  const globalSpent = monthly.reduce((sum, item) => sum + item.estimatedCostInr, 0);
  if (globalSpent + reserve > globalBudget) throw Object.assign(new Error("Global monthly budget would be exceeded for model " + (model ?? "selected model") + "."), { status: 402 });
  if (modulePolicy) {
    const moduleSpent = monthly.filter(item => item.moduleId === moduleId).reduce((sum, item) => sum + item.estimatedCostInr, 0);
    if (modulePolicy.monthlyBudgetInr <= 0 || moduleSpent + reserve > modulePolicy.monthlyBudgetInr) throw Object.assign(new Error("Module monthly budget would be exceeded for " + moduleId + "."), { status: 402 });
  }
  if (opts.modelKey && modelPolicy) {
    const [providerName, modelId] = opts.modelKey.split("::");
    const modelSpent = monthly.filter(item => item.provider === providerName && item.model === modelId).reduce((sum, item) => sum + item.estimatedCostInr, 0);
    if (modelPolicy.monthlyBudgetInr <= 0 || modelSpent + reserve > modelPolicy.monthlyBudgetInr) throw Object.assign(new Error("Model monthly budget would be exceeded for " + modelId + "."), { status: 402 });
  }
}
export function tokenUsageValues(usage?: TokenUsage) {
  const promptTokens = Math.max(0, Math.round(usage?.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.round(usage?.completion_tokens ?? 0));
  const totalTokens = Math.max(0, Math.round(usage?.total_tokens ?? promptTokens + completionTokens));
  const usageReported = Boolean(usage && (
    usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined || usage.total_tokens !== undefined
  ));
  return { promptTokens, completionTokens, totalTokens, usageReported };
}
