import { NextResponse } from "next/server";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { GATEWAY_MODULES, getDefaultModelPolicy, getGatewaySettings, modelKey } from "@/src/model-gateway/control-store";
import { findOpenRouterModel, isFreeOpenRouterModel } from "@/src/model-gateway/openrouter-catalog";
import { assertBudgetAllows, recordModelUsage, tokenUsageValues } from "@/src/model-gateway/usage-store";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.MODEL_GATEWAY_ACCESS_KEY;
  if (!expected) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-model-gateway-key");
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function usdPerToken(value: unknown) {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Gateway access key required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const ip = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("model-check:" + ip, Date.now(), 10);
  if (!limit.allowed) return NextResponse.json({ error: "Model test rate limit reached. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" } });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "A model check request is required." }, { status: 400 });
  const input = body as Record<string, unknown>;
  const modelId = typeof input.modelId === "string" ? input.modelId : "";
  const moduleId = typeof input.moduleId === "string" ? input.moduleId : "";
  const mode = input.mode === "paid" ? "paid" : input.mode === "free" ? "free" : "";
  if (!modelId || modelId.length > 180 || !/^[a-zA-Z0-9._:/-]+$/.test(modelId)) return NextResponse.json({ error: "Invalid model ID." }, { status: 400 });
  if (!GATEWAY_MODULES.some(module => module.id === moduleId) || !mode) return NextResponse.json({ error: "A supported capability and free/paid mode are required." }, { status: 400 });
  if (!process.env.OPENROUTER_API_KEY) return NextResponse.json({ status: "unavailable", error: "OPENROUTER_API_KEY is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });

  let model;
  try { model = await findOpenRouterModel(modelId); }
  catch (error) {
    return NextResponse.json({ status: "unavailable", error: error instanceof Error ? error.message : "Could not load the live model catalog." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (!model) return NextResponse.json({ status: "unavailable", error: "Model is no longer listed in the current OpenRouter catalog." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const free = isFreeOpenRouterModel(model);
  if (mode === "free" && !free) return NextResponse.json({ status: "blocked", error: "This model is not listed as an explicit zero-price :free route." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (mode === "paid" && free) return NextResponse.json({ status: "blocked", error: "Select Free mode for a :free model." }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const settings = await getGatewaySettings();
  const modulePolicy = settings.modules[moduleId];
  if (!modulePolicy?.enabled) return NextResponse.json({ status: "blocked", error: "This capability is switched off." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (mode === "paid" && (!settings.paidRoutingEnabled || process.env.ALLOW_PAID_MODELS !== "true")) {
    return NextResponse.json({ status: "blocked", error: "Paid test blocked. Enable both the Gateway paid-routing switch and ALLOW_PAID_MODELS=true first." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (mode === "paid" && input.confirmPaid !== true) return NextResponse.json({ status: "confirmation-required", error: "Paid model tests can incur a small charge. Confirm before running." }, { status: 409, headers: { "Cache-Control": "no-store" } });

  const fx = settings.usdToInrRate || 97;
  const inputUsdPerMillion = usdPerToken(model.pricing?.prompt) * 1_000_000;
  const outputUsdPerMillion = usdPerToken(model.pricing?.completion) * 1_000_000;
  const inputInrPerMillion = inputUsdPerMillion * fx;
  const outputInrPerMillion = outputUsdPerMillion * fx;
  const key = modelKey("openrouter", modelId);
  const modelPolicy = settings.models[key] ?? getDefaultModelPolicy("openrouter", modelId, inputUsdPerMillion, outputUsdPerMillion, fx);
  const testPrompt = "Reply with exactly: OK";
  const maxTokens = 8;
  const requestId = randomUUID();
  if (mode === "paid") {
    if (inputInrPerMillion <= 0 || outputInrPerMillion <= 0) return NextResponse.json({ status: "blocked", error: "Exact paid-model prices are missing; billing test was not sent." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    try {
      await assertBudgetAllows(testPrompt.length, maxTokens, process.env, modelId, {
        moduleId, modelKey: key, inputPriceInrPerMillion: inputInrPerMillion,
        outputPriceInrPerMillion: outputInrPerMillion,
        maxRequestCostInr: Math.min(modulePolicy.maxRequestCostInr, modelPolicy.maxRequestCostInr)
      });
    } catch (error) {
      return NextResponse.json({ status: "blocked", error: error instanceof Error ? error.message : "Budget guard blocked the model test." }, { status: 402, headers: { "Cache-Control": "no-store" } });
    }
  }

  const started = Date.now();
  let response: Response;
  let payload: { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string; error?: { message?: string } };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      response = await fetch((process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: testPrompt }], temperature: 0, max_tokens: maxTokens, stream: false }),
        cache: "no-store",
        signal: controller.signal
      });
    } finally { clearTimeout(timer); }
    payload = await response.json().catch(() => ({})) as typeof payload;
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    const status = timeout ? "timeout" : "unavailable";
    const message = timeout ? "Model test timed out after 20 seconds." : "Could not reach OpenRouter for a model test.";
    if (mode === "paid") await recordModelUsage({ requestId, moduleId, provider: "openrouter", model: modelId, tier: "paid", promptTokens: 0, completionTokens: 0, totalTokens: 0, usageReported: false, estimatedCostInr: 0, latencyMs: Date.now() - started, status: "error", note: message });
    return NextResponse.json({ status, error: message, latencyMs: Date.now() - started }, { status: timeout ? 504 : 502, headers: { "Cache-Control": "no-store" } });
  }

  const latencyMs = Date.now() - started;
  if (!response.ok) {
    let status = "unavailable";
    if (response.status === 429) status = "rate-limited";
    else if (response.status === 402) status = "quota-or-billing";
    else if (response.status === 401 || response.status === 403) status = "provider-auth-error";
    else if (response.status === 404) status = "endpoint-not-found";
    else if (response.status >= 500) status = "provider-error";
    const safeMessage = "OpenRouter model test returned HTTP " + response.status + (response.status === 429 ? " (rate limit)." : response.status === 402 ? " (quota or billing limit)." : ".");
    if (mode === "paid") await recordModelUsage({ requestId, moduleId, provider: "openrouter", model: modelId, tier: "paid", promptTokens: 0, completionTokens: 0, totalTokens: 0, usageReported: false, estimatedCostInr: 0, latencyMs, status: "error", note: safeMessage });
    return NextResponse.json({ status, error: safeMessage, latencyMs, httpStatus: response.status }, { status: response.status >= 400 && response.status <= 599 ? response.status : 502, headers: { "Cache-Control": "no-store" } });
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return NextResponse.json({ status: "invalid-response", error: "Provider responded but did not return text content.", latencyMs }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const promptTokens = Math.max(0, Math.round(Number(payload.usage?.prompt_tokens) || Math.ceil(testPrompt.length / 4)));
  const completionTokens = Math.max(0, Math.round(Number(payload.usage?.completion_tokens) || 1));
  const totalTokens = Math.max(promptTokens + completionTokens, Math.round(Number(payload.usage?.total_tokens) || 0));
  const estimatedCostInr = free ? 0 : (promptTokens * inputInrPerMillion + completionTokens * outputInrPerMillion) / 1_000_000;
  if (mode === "paid") await recordModelUsage({ requestId, moduleId, provider: "openrouter", model: modelId, tier: "paid", promptTokens, completionTokens, totalTokens, usageReported: Boolean(payload.usage), estimatedCostInr, latencyMs, status: "success", note: "Explicit paid-model connectivity test; minimal output requested." });
  return NextResponse.json({
    status: "available",
    message: "Model returned a successful response.",
    response: content.slice(0, 80),
    model: payload.model || modelId,
    latencyMs,
    tokenUsage: { promptTokens, completionTokens, totalTokens, reported: Boolean(payload.usage) },
    estimatedCostInr,
    inputUsdPerMillion,
    outputUsdPerMillion,
    contextLength: model.context_length ?? null,
    inputModalities: model.architecture?.input_modalities ?? ["text"],
    checkedAt: new Date().toISOString(),
    requestId
  }, { headers: { "Cache-Control": "no-store" } });
}
