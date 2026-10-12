import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;
type OpenRouterResponse = { data?: unknown };

function matchesSecret(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function amount(value: unknown): number {
  return numberValue(value) ?? 0;
}
function safeError(status: number): string {
  if (status === 401 || status === 403) return "OpenRouter denied access. Verify that the configured key has permission for this endpoint.";
  if (status === 429) return "OpenRouter rate-limited the account check. Wait briefly and refresh.";
  if (status >= 500) return "OpenRouter's account endpoint is temporarily unavailable.";
  return "OpenRouter returned HTTP " + status + ".";
}
async function getOpenRouterJson(endpoint: string, key: string): Promise<{ data?: unknown; error?: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/" + endpoint, {
      method: "GET",
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) return { error: safeError(response.status) };
    const payload = await response.json() as OpenRouterResponse;
    return payload && typeof payload === "object" && "data" in payload
      ? { data: payload.data }
      : { error: "OpenRouter returned an unexpected response format." };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { error: "OpenRouter account check timed out." };
    return { error: "Could not reach OpenRouter. Check the deployment's network and try again." };
  }
}

/**
 * Private account telemetry. The management credential is used only server-side
 * for account credits and analytics; the regular API key is used for /key.
 * No raw provider response or credential is returned to the browser.
 */
export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ ok: false, error: "Cross-origin account requests are not allowed." }, {
      status: 403, headers: { "Cache-Control": "no-store" }
    });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ ok: false, error: "Cross-origin account requests are not allowed." }, {
      status: 403, headers: { "Cache-Control": "no-store" }
    });
  }
  const expectedAdminKey = process.env.MODEL_GATEWAY_ADMIN_KEY;
  if (!expectedAdminKey) {
    return NextResponse.json({ ok: false, error: "OpenRouter account telemetry is locked until MODEL_GATEWAY_ADMIN_KEY is configured on the server." }, {
      status: 503, headers: { "Cache-Control": "no-store" }
    });
  }
  if (!matchesSecret(request.headers.get("x-model-gateway-admin-key"), expectedAdminKey)) {
    return NextResponse.json({ ok: false, error: "Invalid gateway settings admin key." }, {
      status: 401, headers: { "Cache-Control": "no-store" }
    });
  }

  const ip = request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("openrouter-account:" + ip, Date.now(), 6);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "Account refresh rate limit reached. Please wait before refreshing." }, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(limit.retryAfterSeconds) }
    });
  }

  const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const errors: Record<string, string> = {};

  const [creditsResult, activityResult, keyResult] = await Promise.all([
    managementKey ? getOpenRouterJson("credits", managementKey) : Promise.resolve({ error: "Add OPENROUTER_MANAGEMENT_KEY in the server environment to read account credits." }),
    managementKey ? getOpenRouterJson("activity", managementKey) : Promise.resolve({ error: "Add OPENROUTER_MANAGEMENT_KEY in the server environment to read 30-day activity." }),
    apiKey ? getOpenRouterJson("key", apiKey) : managementKey
      ? getOpenRouterJson("key", managementKey)
      : Promise.resolve({ error: "OPENROUTER_API_KEY is not configured in this deployment." })
  ]);

  let credits: null | { totalPurchasedUsd: number; totalUsedUsd: number; availableUsd: number } = null;
  const creditsData = objectValue(creditsResult.data);
  const totalPurchased = numberValue(creditsData?.total_credits);
  const totalUsed = numberValue(creditsData?.total_usage);
  if (totalPurchased !== null && totalUsed !== null) {
    credits = {
      totalPurchasedUsd: totalPurchased,
      totalUsedUsd: totalUsed,
      availableUsd: Number((totalPurchased - totalUsed).toFixed(6))
    };
  } else if (creditsResult.error) errors.credits = creditsResult.error;

  let key = null as null | {
    label: string | null;
    limitUsd: number | null;
    limitRemainingUsd: number | null;
    usageUsd: number;
    usageDailyUsd: number;
    usageWeeklyUsd: number;
    usageMonthlyUsd: number;
    isFreeTier: boolean | null;
    isManagementKey: boolean | null;
    freeModelDailyRequests: { used: number; limit: number; remaining: number } | null;
  };
  const keyData = objectValue(keyResult.data);
  if (keyData) {
    const freeRequests = objectValue(keyData.free_model_daily_requests);
    key = {
      // A key label can itself contain a masked credential. Do not return it.
      label: null,
      limitUsd: numberValue(keyData.limit),
      limitRemainingUsd: numberValue(keyData.limit_remaining),
      usageUsd: amount(keyData.usage),
      usageDailyUsd: amount(keyData.usage_daily),
      usageWeeklyUsd: amount(keyData.usage_weekly),
      usageMonthlyUsd: amount(keyData.usage_monthly),
      isFreeTier: typeof keyData.is_free_tier === "boolean" ? keyData.is_free_tier : null,
      isManagementKey: typeof keyData.is_management_key === "boolean" ? keyData.is_management_key : null,
      freeModelDailyRequests: freeRequests && numberValue(freeRequests.used) !== null &&
        numberValue(freeRequests.limit) !== null && numberValue(freeRequests.remaining) !== null
        ? { used: amount(freeRequests.used), limit: amount(freeRequests.limit), remaining: amount(freeRequests.remaining) }
        : null
    };
  } else if (keyResult.error) errors.key = keyResult.error;

  let activity: null | {
    daysReturned: number;
    activeDays: number;
    totalUsageUsd: number;
    totalRequests: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    averageDailySpendUsd: number;
    daily: Array<{ date: string; usageUsd: number; requests: number }>;
    models: Array<{ model: string; provider: string | null; usageUsd: number; requests: number; promptTokens: number; completionTokens: number }>;
  } = null;
  if (Array.isArray(activityResult.data)) {
    const items = activityResult.data.map(objectValue).filter((item): item is JsonObject => Boolean(item));
    const dailyByDate = new Map<string, { date: string; usageUsd: number; requests: number }>();
    const modelsByName = new Map<string, { model: string; provider: string | null; usageUsd: number; requests: number; promptTokens: number; completionTokens: number }>();
    let totalUsageUsd = 0;
    let totalRequests = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    for (const item of items) {
      const date = typeof item.date === "string" ? item.date.slice(0, 10) : "unknown";
      const usageUsd = amount(item.usage);
      const requests = amount(item.requests);
      const prompt = amount(item.prompt_tokens);
      const completion = amount(item.completion_tokens);
      const reasoning = amount(item.reasoning_tokens);
      totalUsageUsd += usageUsd;
      totalRequests += requests;
      promptTokens += prompt;
      completionTokens += completion;
      reasoningTokens += reasoning;
      const day = dailyByDate.get(date) ?? { date, usageUsd: 0, requests: 0 };
      day.usageUsd += usageUsd;
      day.requests += requests;
      dailyByDate.set(date, day);
      const modelName = typeof item.model === "string" ? item.model.slice(0, 160) : "Unknown model";
      const modelKey = modelName + "\u0000" + (typeof item.provider_name === "string" ? item.provider_name : "");
      const modelRow = modelsByName.get(modelKey) ?? {
        model: modelName,
        provider: typeof item.provider_name === "string" ? item.provider_name.slice(0, 100) : null,
        usageUsd: 0, requests: 0, promptTokens: 0, completionTokens: 0
      };
      modelRow.usageUsd += usageUsd;
      modelRow.requests += requests;
      modelRow.promptTokens += prompt;
      modelRow.completionTokens += completion;
      modelsByName.set(modelKey, modelRow);
    }
    const daily = [...dailyByDate.values()].sort((a, b) => b.date.localeCompare(a.date)).map(item => ({
      ...item, usageUsd: Number(item.usageUsd.toFixed(6)), requests: Math.round(item.requests)
    })).slice(0, 30);
    const activeDays = daily.filter(item => item.date !== "unknown" && item.usageUsd > 0).length;
    const safeTotalUsage = Number(totalUsageUsd.toFixed(6));
    activity = {
      daysReturned: new Set(daily.filter(item => item.date !== "unknown").map(item => item.date)).size,
      activeDays,
      totalUsageUsd: safeTotalUsage,
      totalRequests: Math.round(totalRequests),
      promptTokens: Math.round(promptTokens),
      completionTokens: Math.round(completionTokens),
      reasoningTokens: Math.round(reasoningTokens),
      // The provider returns the last 30 completed UTC days, grouped by date/model.
      averageDailySpendUsd: Number((safeTotalUsage / 30).toFixed(6)),
      daily,
      models: [...modelsByName.values()]
        .sort((a, b) => b.usageUsd - a.usageUsd)
        .map(item => ({ ...item, usageUsd: Number(item.usageUsd.toFixed(6)), requests: Math.round(item.requests) }))
        .slice(0, 10)
    };
  } else if (activityResult.error) errors.activity = activityResult.error;

  return NextResponse.json({
    ok: Boolean(credits || key || activity),
    checkedAt: new Date().toISOString(),
    credentials: { apiKeyConfigured: Boolean(apiKey), managementKeyConfigured: Boolean(managementKey) },
    credits,
    key,
    activity,
    errors
  }, { headers: { "Cache-Control": "no-store" } });
}
