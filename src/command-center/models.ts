import { readBudgetStats, readCallStats, readModelUsage, type BudgetStats, type CallStats, type CallStatsSection, type ModelUsage } from "@/src/llm-gateway/call-log";
import { seatFor } from "@/src/llm-gateway/roles";
import { gatewayAvailability, gatewayChatCompletion, gatewayEnv } from "@/src/llm-gateway/router";
import { PROVIDERS, modelDailyLimits, modelLimits, modelTier, providerKeys } from "@/src/llm-gateway/catalog";
import { llmGatewayMode } from "@/src/providers/active-chat-provider";

export type ModelAnalytics = CallStats & {
  mode: string;
  providers: Array<{ id: string; label: string; models: Array<{ id: string; tier: string; rpm: number; rpd?: number }> }>;
  missingProviders: Array<{ id: string; label: string; secret: string }>;
};

export type ModelsTab = "models" | "roles" | "providers" | "recent";
export const MODELS_TABS: ModelsTab[] = ["models", "roles", "providers", "recent"];

/**
 * Models view: what the gateway can call, and what was called (model, tokens, latency, errors).
 * `tab` loads only that tab's data: "models" also carries the top totals; "providers" runs no DB query.
 * No tab = everything (old behaviour).
 */
export async function loadModelAnalytics(hours: number, tab?: ModelsTab): Promise<ModelAnalytics> {
  const sections: CallStatsSection[] = !tab ? ["models", "roles", "recent"] : tab === "providers" ? [] : [tab];
  const needProviders = !tab || tab === "providers";
  const [stats, availability] = await Promise.all([
    sections.length ? readCallStats(hours, sections) : Promise.resolve({ window: Math.max(1, Math.min(720, Math.round(hours))) + "h", totals: { calls: 0, ok: 0, tokens: 0, avgLatencyMs: 0 }, models: [], roles: [], recent: [] }),
    needProviders ? gatewayAvailability() : Promise.resolve({ providers: [] as Array<{ id: string; label: string; models: string[] }> }),
  ]);
  const configured = new Set(availability.providers.map((provider) => provider.id));
  return {
    ...stats,
    mode: llmGatewayMode(),
    providers: availability.providers.map((provider) => {
      const def = PROVIDERS.find((entry) => entry.id === provider.id)!;
      return {
        id: provider.id,
        label: provider.label,
        models: provider.models.map((model) => ({ id: model, tier: modelTier(model), ...modelLimits(def, model) })),
      };
    }),
    missingProviders: !needProviders ? [] : PROVIDERS.filter((provider) => !configured.has(provider.id) && provider.keyEnv.length)
      .map((provider) => ({ id: provider.id, label: provider.label, secret: provider.keyEnv[0] })),
  };
}

export type ProviderCheck = { provider: string; model: string; ok: boolean; status: number; latencyMs: number; answer?: string; error?: string };

let lastCheckAt = 0;

/** Live check: one tiny pinned call per configured provider (no key values are ever returned). */
export async function checkGatewayProviders(): Promise<{ checkedAt: string; log: { ok: boolean; error?: string }; results: ProviderCheck[]; openrouter?: { freeTier?: boolean; dailyFreeLimit?: number; error?: string } } | { throttled: true; retryAfterSeconds: number }> {
  const now = Date.now();
  if (now - lastCheckAt < 60_000) return { throttled: true, retryAfterSeconds: Math.ceil((60_000 - (now - lastCheckAt)) / 1000) };
  lastCheckAt = now;
  const availability = await gatewayAvailability();
  const results = await Promise.all(availability.providers.map(async (provider): Promise<ProviderCheck> => {
    const model = provider.models[0];
    const started = Date.now();
    const response = await gatewayChatCompletion(JSON.stringify({
      model: provider.id + ":" + model,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_tokens: 400,
      temperature: 0,
    }), new Headers({ "X-UXD-Agent-Role": "classifier", "X-UXD-Gateway-Strict": "1" }), AbortSignal.timeout(30_000));
    const latencyMs = Date.now() - started;
    const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
    const routed = response.headers.get("x-routed-via") || "";
    const answer = typeof payload.choices?.[0]?.message?.content === "string" ? payload.choices[0].message.content.slice(0, 40) : undefined;
    return {
      provider: provider.id, model, ok: response.ok && routed.startsWith(provider.id + "/"), status: response.status, latencyMs,
      ...(answer ? { answer } : {}),
      ...(!response.ok ? { error: String(payload.error?.message || "HTTP " + response.status).slice(0, 300) } : {}),
    };
  }));
  // OpenRouter account allowance: 1000 free calls/day once the account has bought credit, else 50.
  let openrouter: { freeTier?: boolean; dailyFreeLimit?: number; error?: string } | undefined;
  const orKey = providerKeys(PROVIDERS.find((provider) => provider.id === "openrouter")!, gatewayEnv())[0];
  if (orKey) {
    try {
      const keyInfo = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: "Bearer " + orKey }, signal: AbortSignal.timeout(8_000) })
        .then((response) => response.json()) as { data?: { is_free_tier?: boolean } };
      const freeTier = keyInfo.data?.is_free_tier;
      openrouter = typeof freeTier === "boolean" ? { freeTier, dailyFreeLimit: freeTier ? 50 : 1000 } : { error: "no key info" };
    } catch (error) { openrouter = { error: error instanceof Error ? error.message.slice(0, 120) : String(error) }; }
  }
  let log: { ok: boolean; error?: string } = { ok: true };
  try { await readModelUsage(); } catch (error) { log = { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
  return { checkedAt: new Date().toISOString(), log, results, ...(openrouter ? { openrouter } : {}) };
}

// ---------- token budget (Models page overview) ----------

export type BudgetModelRow = {
  model: string; rpd?: number; tpd?: number; callsToday: number; tokensToday: number;
  requestsLeft?: number; tokensLeft?: number;
};
export type ModelBudget = {
  generatedAt: string;
  resetsAt: string;
  requests: { limit: number; used: number; remaining: number; coveredModels: number; totalModels: number };
  tokens: { limit: number; usedOnLimited: number; remaining: number; usedToday: number; coveredModels: number; totalModels: number };
  last24h: BudgetStats["last24h"];
  pace: { callsPerHour: number; tokensPerHour: number; projected24hCalls: number; projected24hTokens: number; hoursUntilRequestsOut: number | null };
  hourly: BudgetStats["hourly"];
  roles: Array<{ seat: string; label: string; calls: number; ok: number; tokens: number; promptTokens: number; completionTokens: number; share: number; topModel: string; sources: string[] }>;
  providers: Array<{ id: string; label: string; source: string; accountRpd?: number; callsToday: number; tokensToday: number; models: BudgetModelRow[] }>;
  notes: string[];
};

const SEAT_LABELS: Record<string, string> = {
  director: "UX Director", lead: "UX Lead", "product-designer": "Product Designer", "ux-designer": "UX Designer",
  "ui-designer": "UI Designer", researcher: "Researcher", "content-writer": "UX Writer", accessibility: "Accessibility",
  "design-system": "Design system", qa: "QA", classifier: "Router / classifier", chat: "Chat", "fast-retry": "Fast retry", default: "Other",
};

/** Pure budget maths (tested): published limits vs. what the call log says was used. */
export function buildBudget(input: {
  providers: Array<{ id: string; label: string; models: string[] }>;
  usage: ModelUsage[];
  stats: BudgetStats;
  now?: number;
}): ModelBudget {
  const now = input.now ?? Date.now();
  const midnight = new Date(now); midnight.setUTCHours(24, 0, 0, 0);
  const usage = new Map(input.usage.map((row) => [row.provider + "/" + row.model, row]));
  const requests = { limit: 0, used: 0, remaining: 0, coveredModels: 0, totalModels: 0 };
  const tokens = { limit: 0, usedOnLimited: 0, remaining: 0, usedToday: input.stats.today.tokens, coveredModels: 0, totalModels: 0 };
  const providers: ModelBudget["providers"] = [];
  for (const provider of input.providers) {
    const def = PROVIDERS.find((entry) => entry.id === provider.id);
    if (!def) continue;
    const rows: BudgetModelRow[] = [];
    let callsToday = 0; let tokensToday = 0;
    for (const model of provider.models) {
      const limits = modelDailyLimits(def, model);
      const used = usage.get(provider.id + "/" + model);
      const row: BudgetModelRow = {
        model, rpd: limits.rpd, tpd: limits.tpd, callsToday: used?.today ?? 0, tokensToday: used?.tokensToday ?? 0,
        ...(limits.rpd ? { requestsLeft: Math.max(0, limits.rpd - (used?.today ?? 0)) } : {}),
        ...(limits.tpd ? { tokensLeft: Math.max(0, limits.tpd - (used?.tokensToday ?? 0)) } : {}),
      };
      rows.push(row);
      callsToday += row.callsToday; tokensToday += row.tokensToday;
      requests.totalModels++; tokens.totalModels++;
      if (limits.rpd && !def.accountRpd) { requests.limit += limits.rpd; requests.used += Math.min(limits.rpd, row.callsToday); requests.coveredModels++; }
      if (limits.tpd) { tokens.limit += limits.tpd; tokens.usedOnLimited += Math.min(limits.tpd, row.tokensToday); tokens.coveredModels++; }
    }
    if (def.accountRpd) {
      requests.limit += def.accountRpd; requests.used += Math.min(def.accountRpd, callsToday); requests.coveredModels += provider.models.length;
    }
    providers.push({ id: provider.id, label: provider.label, source: modelDailyLimits(def, provider.models[0] || "").source, ...(def.accountRpd ? { accountRpd: def.accountRpd } : {}), callsToday, tokensToday, models: rows });
  }
  requests.remaining = Math.max(0, requests.limit - requests.used);
  tokens.remaining = Math.max(0, tokens.limit - tokens.usedOnLimited);

  const callsPerHour = input.stats.last3h.calls / 3;
  const tokensPerHour = input.stats.last3h.tokens / 3;
  const hoursToReset = (midnight.getTime() - now) / 3_600_000;
  const hoursUntilRequestsOut = callsPerHour > 0 && requests.limit ? requests.remaining / callsPerHour : null;

  const bySeat = new Map<string, ModelBudget["roles"][number]>();
  for (const row of input.stats.roles) {
    const seat = seatFor(row.role) ?? row.role;
    const entry = bySeat.get(seat) ?? { seat, label: SEAT_LABELS[seat] || seat, calls: 0, ok: 0, tokens: 0, promptTokens: 0, completionTokens: 0, share: 0, topModel: row.topModel, sources: [] };
    entry.calls += row.calls; entry.ok += row.ok; entry.tokens += row.tokens; entry.promptTokens += row.promptTokens; entry.completionTokens += row.completionTokens;
    if (row.role !== seat) entry.sources.push(row.role);
    if (!entry.topModel) entry.topModel = row.topModel;
    bySeat.set(seat, entry);
  }
  const totalRoleTokens = [...bySeat.values()].reduce((sum, row) => sum + row.tokens, 0);
  const roles = [...bySeat.values()].map((row) => ({ ...row, share: totalRoleTokens ? Math.round(row.tokens / totalRoleTokens * 1000) / 10 : 0 }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);

  return {
    generatedAt: new Date(now).toISOString(),
    resetsAt: midnight.toISOString(),
    requests, tokens,
    last24h: input.stats.last24h,
    pace: {
      callsPerHour: Math.round(callsPerHour * 10) / 10, tokensPerHour: Math.round(tokensPerHour),
      projected24hCalls: Math.round(callsPerHour * 24), projected24hTokens: Math.round(tokensPerHour * 24),
      hoursUntilRequestsOut: hoursUntilRequestsOut !== null && hoursUntilRequestsOut < hoursToReset ? Math.round(hoursUntilRequestsOut * 10) / 10 : null,
    },
    hourly: input.stats.hourly,
    roles,
    providers,
    notes: [
      "Daily limits reset at 00:00 UTC (05:30 IST). Used = calls in the call log since then, by UX Direct's gateway and by FreeLLMAPI (same keys).",
      "Request budget counts only models whose provider publishes a daily request limit; OpenRouter's 1000/day is one shared account limit.",
      "Token budget counts only models with a published daily token limit (Groq, Cerebras). Gemini, OpenRouter, Mistral, Workers AI and Z.ai publish none, so their tokens are tracked as used but have no total.",
      "Pace = average of the last 3 hours; projection = that pace for 24 hours.",
    ],
  };
}

/** Models page overview: budget, pace and per-seat consumption. */
export async function loadModelBudget(): Promise<ModelBudget> {
  const [availability, usage, stats] = await Promise.all([gatewayAvailability(), readModelUsage(), readBudgetStats()]);
  return buildBudget({ providers: availability.providers, usage, stats });
}
