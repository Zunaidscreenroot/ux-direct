import { randomUUID } from "node:crypto";
import type { ProviderConfig, TokenUsage } from "./index";

export type UsageRecord = {
  id: string;
  at: string;
  requestId: string;
  provider: string;
  model: string;
  tier: "local" | "free-tier" | "paid" | "mock";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
  retention: "best-effort-runtime";
};

const records: UsageRecord[] = [];
const MAX_RECORDS = 1000;

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
function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
export function estimateCostInr(promptTokens: number, completionTokens: number, provider: ProviderConfig, env = process.env) {
  if (provider.kind === "local" || provider.kind === "free-tier" || provider.kind === "mock") return 0;
  const config = getBudgetConfig(env);
  return promptTokens * config.inputPriceInrPerMillion / 1_000_000 +
    completionTokens * config.outputPriceInrPerMillion / 1_000_000;
}
export function recordModelUsage(input: Omit<UsageRecord, "id" | "at"> & { id?: string; at?: string }) {
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
  };
  records.unshift(item);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  // Log only metadata, never prompts, completions, or credentials.
  console.info("[model-gateway-usage]", JSON.stringify(item));
  return item;
}
export function getBudgetSnapshot(env = process.env, now = new Date()): BudgetSnapshot {
  const config = getBudgetConfig(env);
  const month = monthKey(now);
  const monthly = records.filter(item => item.at.slice(0, 7) === month);
  const spent = monthly.reduce((total, item) => total + item.estimatedCostInr, 0);
  return {
    currency: "INR",
    monthlyBudgetInr: config.monthlyBudgetInr,
    spentThisMonthInr: Number(spent.toFixed(4)),
    remainingInr: Math.max(0, Number((config.monthlyBudgetInr - spent).toFixed(4))),
    percentUsed: config.monthlyBudgetInr > 0 ? Math.min(100, Number((spent / config.monthlyBudgetInr * 100).toFixed(2))) : 100,
    inputPriceInrPerMillion: config.inputPriceInrPerMillion,
    outputPriceInrPerMillion: config.outputPriceInrPerMillion,
    pricingConfigured: config.inputPriceInrPerMillion > 0 && config.outputPriceInrPerMillion > 0,
    month,
    records: monthly.slice(0, 200),
    retention: "best-effort-runtime"
  };
}
export function assertBudgetAllows(promptChars: number, maxOutputTokens = 1024, env = process.env) {
  const snapshot = getBudgetSnapshot(env);
  if (!snapshot.pricingConfigured) {
    throw Object.assign(new Error("Paid model requests are blocked until both input and output token prices are configured in INR per million tokens."), { status: 503 });
  }
  if (snapshot.monthlyBudgetInr <= 0) {
    throw Object.assign(new Error("Paid model requests are blocked because the monthly budget is zero."), { status: 402 });
  }
  const estimatedPromptTokens = Math.ceil(promptChars / 4);
  const reserve = estimatedPromptTokens * snapshot.inputPriceInrPerMillion / 1_000_000 +
    maxOutputTokens * snapshot.outputPriceInrPerMillion / 1_000_000;
  if (snapshot.spentThisMonthInr + reserve > snapshot.monthlyBudgetInr) {
    throw Object.assign(new Error("Monthly budget guard blocked this request because its estimated maximum cost exceeds the remaining budget."), { status: 402 });
  }
}
export function tokenUsageValues(usage?: TokenUsage) {
  const promptTokens = Math.max(0, Math.round(usage?.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.round(usage?.completion_tokens ?? 0));
  const totalTokens = Math.max(0, Math.round(usage?.total_tokens ?? promptTokens + completionTokens));
  return { promptTokens, completionTokens, totalTokens };
}
