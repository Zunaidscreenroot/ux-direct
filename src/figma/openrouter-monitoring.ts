type JsonRecord = Record<string, unknown>;
type ActivityRow = {
  model?: unknown;
  model_permaslug?: unknown;
  usage?: unknown;
  requests?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  reasoning_tokens?: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function metric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function sum(rows: ActivityRow[], field: keyof ActivityRow): number {
  return rows.reduce((total, row) => total + (metric(row[field]) ?? 0), 0);
}

export type OpenRouterSpendMonitoring = {
  configured: boolean;
  available: boolean;
  checkedAt: string;
  error?: string;
  credits: {
    totalCreditsUsd: number | null;
    totalUsageUsd: number | null;
    remainingUsd: number | null;
  } | null;
  activity30d: {
    spendUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    topModels: Array<{ model: string; spendUsd: number; requests: number }>;
  } | null;
};

/**
 * Uses the server-only OpenRouter Management API key for read-only spending
 * telemetry. The key is never returned to the client and is not used for
 * completions. The regular OPENROUTER_API_KEY remains the inference credential.
 * Cache account telemetry briefly so every chat request does not make another
 * administrative API call. The cache is per serverless instance, not a ledger.
 */
let cachedMonitoring: { fetchedAt: number; value: OpenRouterSpendMonitoring } | null = null;
const MONITORING_CACHE_MS = 60_000;

export async function getOpenRouterSpendMonitoring(): Promise<OpenRouterSpendMonitoring> {
  if (cachedMonitoring && Date.now() - cachedMonitoring.fetchedAt < MONITORING_CACHE_MS) {
    return cachedMonitoring.value;
  }
  const checkedAt = new Date().toISOString();
  const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!managementKey) {
    return {
      configured: false, available: false, checkedAt,
      error: "Management API key is not configured for this deployment.",
      credits: null, activity30d: null,
    };
  }

  const baseUrl = "https://openrouter.ai/api/v1";
  const fetchJson = async (path: string): Promise<{ ok: boolean; status: number; data: unknown }> => {
    try {
      const response = await fetch(baseUrl + path, {
        method: "GET",
        headers: { Authorization: "Bearer " + managementKey, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(7000),
      });
      const data: unknown = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  };

  const [creditsResponse, activityResponse] = await Promise.all([
    fetchJson("/credits"),
    fetchJson("/activity"),
  ]);
  const creditsRoot = isRecord(creditsResponse.data) && isRecord(creditsResponse.data.data) ? creditsResponse.data.data : null;
  const activityRoot = isRecord(activityResponse.data) && Array.isArray(activityResponse.data.data) ? activityResponse.data.data as ActivityRow[] : null;

  const totalCreditsUsd = metric(creditsRoot?.total_credits);
  const totalUsageUsd = metric(creditsRoot?.total_usage);
  const remainingUsd = totalCreditsUsd !== null && totalUsageUsd !== null
    ? Math.max(0, totalCreditsUsd - totalUsageUsd)
    : null;

  let activity30d: OpenRouterSpendMonitoring["activity30d"] = null;
  if (activityRoot) {
    const byModel = new Map<string, { spendUsd: number; requests: number }>();
    for (const row of activityRoot) {
      const model = (typeof row.model_permaslug === "string" && row.model_permaslug)
        || (typeof row.model === "string" && row.model)
        || "unknown";
      const previous = byModel.get(model) || { spendUsd: 0, requests: 0 };
      previous.spendUsd += metric(row.usage) ?? 0;
      previous.requests += metric(row.requests) ?? 0;
      byModel.set(model, previous);
    }
    activity30d = {
      spendUsd: sum(activityRoot, "usage"),
      requests: sum(activityRoot, "requests"),
      promptTokens: sum(activityRoot, "prompt_tokens"),
      completionTokens: sum(activityRoot, "completion_tokens"),
      topModels: [...byModel.entries()]
        .map(([model, value]) => ({ model, spendUsd: value.spendUsd, requests: value.requests }))
        .sort((a, b) => b.spendUsd - a.spendUsd)
        .slice(0, 5),
    };
  }

  const available = (creditsResponse.ok && totalCreditsUsd !== null) || Boolean(activityRoot);
  const result: OpenRouterSpendMonitoring = {
    configured: true,
    available,
    checkedAt,
    ...(!available ? {
      error: "OpenRouter Monitoring API could not be verified (credits HTTP " + creditsResponse.status + ", activity HTTP " + activityResponse.status + ").",
    } : {}),
    credits: totalCreditsUsd !== null || totalUsageUsd !== null
      ? { totalCreditsUsd, totalUsageUsd, remainingUsd }
      : null,
    activity30d,
  };
  if (result.available) cachedMonitoring = { fetchedAt: Date.now(), value: result };
  return result;
}
