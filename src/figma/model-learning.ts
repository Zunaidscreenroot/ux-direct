import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;
export type ModelLearningOutcome =
  | "usable"
  | "validated"
  | "validation_failure"
  | "provider_error"
  | "budget_blocked";

export type ModelLearningEventInput = {
  requestId?: string;
  capability: string;
  modelId: string;
  modelTier: "free-tier" | "paid";
  outcome: ModelLearningOutcome;
  validationPassed?: boolean;
  latencyMs?: number;
  estimatedCostUsd?: number;
  observedCostUsd?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  operationProfile?: Record<string, unknown>;
  errorCategory?: string;
};

export type ModelLearningScore = {
  modelId: string;
  attempts: number;
  usable: number;
  validated: number;
  failures: number;
  successRate: number;
  validationRate: number;
  averageEstimatedCostUsd: number;
  averageObservedCostUsd: number | null;
  averageLatencyMs: number | null;
  routingScore: number;
};

export type ModelLearningContext = {
  available: boolean;
  sampleCount: number;
  promptContext: string;
  modelScores: Record<string, ModelLearningScore>;
};

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return url && key ? { url, key } : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function shortText(value: unknown, max = 80): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}
function tableUrl(base: string, query: URLSearchParams) {
  return base + "/rest/v1/uxd_model_learning_events?" + query.toString();
}

async function fetchLearningRows(query: URLSearchParams): Promise<JsonRecord[] | null> {
  const config = supabaseConfig();
  if (!config) return null;
  try {
    const response = await fetch(tableUrl(config.url, query), {
      method: "GET",
      headers: {
        apikey: config.key,
        Authorization: "Bearer " + config.key,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(1400),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json().catch(() => null);
    return Array.isArray(data) ? data.filter(isRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Persist only model-performance signals and structural counts. The request
 * text, selected layer tree, image, generated copy, and Figma file key are never
 * stored in this table. This is best-effort telemetry and never blocks a run.
 */
export async function recordModelLearningEvent(input: ModelLearningEventInput): Promise<void> {
  const config = supabaseConfig();
  if (!config) return;

  const operationProfile: JsonRecord = {};
  if (input.operationProfile && isRecord(input.operationProfile)) {
    for (const [key, value] of Object.entries(input.operationProfile).slice(0, 20)) {
      if (typeof value === "number" && Number.isFinite(value)) operationProfile[key.slice(0, 64)] = Math.max(0, Math.min(value, 100000));
      else if (typeof value === "boolean" || (typeof value === "string" && value.length <= 80)) {
        operationProfile[key.slice(0, 64)] = value;
      }
    }
  }

  const row = {
    request_id: shortText(input.requestId, 120) || randomUUID(),
    capability: shortText(input.capability, 80) || "unknown",
    model_id: shortText(input.modelId, 200) || "unknown",
    model_tier: input.modelTier,
    outcome: input.outcome,
    validation_passed: input.validationPassed === true,
    latency_ms: finiteNonNegative(input.latencyMs),
    estimated_cost_usd: finiteNonNegative(input.estimatedCostUsd),
    observed_cost_usd: finiteNonNegative(input.observedCostUsd),
    prompt_tokens: finiteNonNegative(input.promptTokens),
    completion_tokens: finiteNonNegative(input.completionTokens),
    total_tokens: finiteNonNegative(input.totalTokens),
    operation_profile: operationProfile,
    error_category: shortText(input.errorCategory, 80) || null,
  };

  try {
    await fetch(config.url + "/rest/v1/uxd_model_learning_events", {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: "Bearer " + config.key,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
      cache: "no-store",
      signal: AbortSignal.timeout(1400),
    });
  } catch {
    // Learning must never make the user's design request fail.
  }
}

/**
 * Retrieves anonymized outcomes from the last 90 days. It produces a compact
 * operational memory and per-model score that can tune routing after enough
 * evidence exists, while preserving the capability registry as the hard gate.
 */
export async function getModelLearningContext(capability: string): Promise<ModelLearningContext> {
  const query = new URLSearchParams({
    select: "capability,model_id,model_tier,outcome,validation_passed,latency_ms,estimated_cost_usd,observed_cost_usd,operation_profile,created_at",
    capability: "eq." + capability,
    created_at: "gte." + new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    order: "created_at.desc",
    limit: "250",
  });
  const rows = await fetchLearningRows(query);
  if (!rows) return { available: false, sampleCount: 0, promptContext: "", modelScores: {} };

  const grouped = new Map<string, { attempts: number; usable: number; validated: number; failures: number; costs: number[]; observedCosts: number[]; latencies: number[]; profiles: JsonRecord[] }>();
  for (const row of rows) {
    const outcome = row.outcome;
    if (outcome === "budget_blocked") continue;
    const modelId = shortText(row.model_id, 200);
    if (!modelId) continue;
    const aggregate = grouped.get(modelId) || { attempts: 0, usable: 0, validated: 0, failures: 0, costs: [], observedCosts: [], latencies: [], profiles: [] };
    aggregate.attempts += 1;
    if (outcome === "usable" || outcome === "validated") aggregate.usable += 1;
    if (outcome === "validated" || row.validation_passed === true) aggregate.validated += 1;
    if (outcome === "validation_failure" || outcome === "provider_error") aggregate.failures += 1;
    const estimated = finiteNonNegative(row.estimated_cost_usd);
    const observed = finiteNonNegative(row.observed_cost_usd);
    const latency = finiteNonNegative(row.latency_ms);
    if (estimated !== null) aggregate.costs.push(estimated);
    if (observed !== null) aggregate.observedCosts.push(observed);
    if (latency !== null) aggregate.latencies.push(latency);
    if (row.validation_passed === true && isRecord(row.operation_profile)) aggregate.profiles.push(row.operation_profile);
    grouped.set(modelId, aggregate);
  }

  const modelScores: Record<string, ModelLearningScore> = {};
  for (const [modelId, aggregate] of grouped.entries()) {
    const successRate = aggregate.attempts ? aggregate.usable / aggregate.attempts : 0;
    const validationRate = aggregate.attempts ? aggregate.validated / aggregate.attempts : 0;
    const averageEstimatedCostUsd = aggregate.costs.length ? aggregate.costs.reduce((a, b) => a + b, 0) / aggregate.costs.length : 0;
    const averageObservedCostUsd = aggregate.observedCosts.length ? aggregate.observedCosts.reduce((a, b) => a + b, 0) / aggregate.observedCosts.length : null;
    const averageLatencyMs = aggregate.latencies.length ? aggregate.latencies.reduce((a, b) => a + b, 0) / aggregate.latencies.length : null;
    modelScores[modelId] = {
      modelId,
      attempts: aggregate.attempts,
      usable: aggregate.usable,
      validated: aggregate.validated,
      failures: aggregate.failures,
      successRate,
      validationRate,
      averageEstimatedCostUsd,
      averageObservedCostUsd,
      averageLatencyMs,
      // $0.01 of average spend is worth ten routing points. Quality/reliability
      // remains dominant, but costs can break close ties among capable models.
      routingScore: successRate * 100 + validationRate * 12 - averageEstimatedCostUsd * 1000,
    };
  }

  const mature = Object.values(modelScores)
    .filter((score) => score.attempts >= 3)
    .sort((a, b) => b.routingScore - a.routingScore)
    .slice(0, 4);
  const sampleCount = rows.filter((row) => row.outcome !== "budget_blocked").length;
  let promptContext = "";
  if (sampleCount > 0) {
    const lines = [
      "Persistent UX Direct operating memory, learned from " + sampleCount + " anonymized run attempt(s) for this capability over the last 90 days.",
      "These metrics are routing evidence, not a replacement for the current requirements. Preserve all banking guardrails, use only supplied product facts, and do not reuse any client-specific text or values from past runs.",
    ];
    if (mature.length) {
      lines.push("Models with at least three prior attempts, ranked by usable-output rate, validation rate, then cost:");
      for (const score of mature) {
        lines.push(
          "- " + score.modelId + ": " + Math.round(score.successRate * 100) + "% usable (" + score.usable + "/" + score.attempts + "), " +
          Math.round(score.validationRate * 100) + "% passed server-side validation, estimated average $" + score.averageEstimatedCostUsd.toFixed(5) +
          (score.averageLatencyMs === null ? "" : ", average latency " + Math.round(score.averageLatencyMs) + " ms") + "."
        );
      }
    } else {
      lines.push("There are not yet enough repeated runs to override the default model order; keep the capability registry order until at least one model has three attempts.");
    }

    const profiles = rows
      .filter((row) => row.validation_passed === true && isRecord(row.operation_profile))
      .map((row) => row.operation_profile as JsonRecord);
    const totals = profiles.map((p) => finiteNonNegative(p.totalOperations)).filter((n): n is number => n !== null);
    const structures = profiles.map((p) => finiteNonNegative(p.structuralOperations)).filter((n): n is number => n !== null);
    if (profiles.length >= 2 && totals.length && structures.length) {
      const avgTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
      const avgStructure = structures.reduce((a, b) => a + b, 0) / structures.length;
      lines.push("Historically validated structured plans averaged " + avgTotal.toFixed(1) + " total operations and " + avgStructure.toFixed(1) + " structural operations. Use as a quality reference, not a fixed template.");
    }
    promptContext = lines.join("\n");
  }

  return { available: true, sampleCount, promptContext, modelScores };
}

export type ModelLearningOverview = {
  available: boolean;
  runs: number;
  capabilities: number;
  validated: number;
  failures: number;
  lastRunAt: string | null;
  estimatedCostUsd90d: number;
  observedCostUsd90d: number;
};

export async function getModelLearningOverview(): Promise<ModelLearningOverview> {
  const query = new URLSearchParams({
    select: "capability,outcome,validation_passed,estimated_cost_usd,observed_cost_usd,created_at",
    created_at: "gte." + new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    order: "created_at.desc",
    limit: "1000",
  });
  const rows = await fetchLearningRows(query);
  if (!rows) {
    return { available: false, runs: 0, capabilities: 0, validated: 0, failures: 0, lastRunAt: null, estimatedCostUsd90d: 0, observedCostUsd90d: 0 };
  }
  return {
    available: true,
    runs: rows.filter((row) => row.outcome !== "budget_blocked").length,
    capabilities: new Set(rows.map((row) => row.capability).filter((v) => typeof v === "string")).size,
    validated: rows.filter((row) => row.validation_passed === true).length,
    failures: rows.filter((row) => row.outcome === "provider_error" || row.outcome === "validation_failure").length,
    lastRunAt: typeof rows[0]?.created_at === "string" ? rows[0].created_at : null,
    estimatedCostUsd90d: rows.reduce((sum, row) => sum + (finiteNonNegative(row.estimated_cost_usd) || 0), 0),
    observedCostUsd90d: rows.reduce((sum, row) => sum + (finiteNonNegative(row.observed_cost_usd) || 0), 0),
  };
}
