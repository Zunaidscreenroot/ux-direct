import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { GatewayError, chatCompletionWithOpenRouterPaid } from "@/src/model-gateway";
import {
  getOpenRouterFreeChatModel,
  getOpenRouterPaidChatModel,
  OPENROUTER_FREE_CHAT_MODELS,
  OPENROUTER_PAID_CHAT_MODELS
} from "@/src/model-gateway/openrouter-paid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Preview-only diagnostic route: model discovery and probes call provider APIs directly.

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
type ProviderId = "openrouter";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
}
function originAllowed(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}
function pluginOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return Boolean(origin && ALLOWED_ORIGINS.has(origin));
}
function approvedFileKey(request: Request, fileKey: unknown) {
  return !pluginOrigin(request) || isAllowedFigmaFileKey(typeof fileKey === "string" ? fileKey : null);
}
function diagnosticId() {
  return `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown model-status error.";
  return message.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]").slice(0, 220);
}
function providerConfig(_provider: ProviderId) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return apiKey ? {
    apiKey,
    baseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    modelsUrl: "https://openrouter.ai/api/v1/models",
    headers: { Authorization: "Bearer " + apiKey }
  } : null;
}
async function timedFetch(url: string, init: RequestInit = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}
async function discoverModels(provider: ProviderId) {
  const config = providerConfig(provider);
  if (!config) return { provider, configured: false, models: [], reason: `${provider} API key is missing in this deployment context.` };
  const response = await timedFetch(config.modelsUrl, { headers: config.headers }, 12000);
  if (!response.ok) return { provider, configured: true, models: [], reason: `Provider model-list endpoint returned HTTP ${response.status}.` };
  const payload = await response.json() as { data?: Array<{ id?: string; name?: string; supportedGenerationMethods?: string[]; pricing?: { prompt?: string; completion?: string } }>; models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  const liveIds = new Set((payload.data ?? []).map(item => item.id).filter((id): id is string => typeof id === "string"));
  // This product uses only the two user-approved free models, never the wider live catalog.
  const models = OPENROUTER_FREE_CHAT_MODELS.filter(model => liveIds.has(model.id)).map(model => model.id);
  const paidModels = OPENROUTER_PAID_CHAT_MODELS.flatMap(model => {
    const live = (payload.data ?? []).find(item => item.id === model.id);
    const liveInputPerToken = Number(live?.pricing?.prompt);
    const liveOutputPerToken = Number(live?.pricing?.completion);
    const liveInputPrice = liveInputPerToken * 1_000_000;
    const liveOutputPrice = liveOutputPerToken * 1_000_000;
    // Never list paid inference unless the live catalog confirms the exact ID,
    // and our conservative budget reserve covers its published token rates.
    if (!live || !(liveInputPrice > 0) || !(liveOutputPrice > 0) ||
        liveInputPrice > model.budgetInputUsdPerMillion ||
        liveOutputPrice > model.budgetOutputUsdPerMillion) return [];
    return [{
      provider: "openrouter",
      id: model.id,
      label: model.label + " · $" + liveInputPrice.toFixed(3) + " in / $" + liveOutputPrice.toFixed(3) + " out per 1M",
      configured: true,
      tier: "paid",
      available: true,
      supportsImages: model.supportsImages,
      listedInputUsdPerMillion: liveInputPrice,
      listedOutputUsdPerMillion: liveOutputPrice,
      budgetInputUsdPerMillion: model.budgetInputUsdPerMillion,
      budgetOutputUsdPerMillion: model.budgetOutputUsdPerMillion,
      pricingSource: model.pricingSource
    }];
  });
  return { provider, configured: true, models, paidModels, checkedAt: new Date().toISOString() };
}
function sanitizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const message = value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
  return message || undefined;
}

async function probeModel(provider: ProviderId, model: string) {
  const config = providerConfig(provider);
  if (!config) return { available: false, provider, model, reason: `${provider} API key is missing in this deployment context.` };
  const paidModel = getOpenRouterPaidChatModel(model);
  const freeModel = getOpenRouterFreeChatModel(model);
  if ((!model.endsWith(":free") && !paidModel) || (model.endsWith(":free") && !freeModel)) {
    return { available: false, provider, model, status: 400, reason: "Only free IDs or explicitly allowlisted low-cost paid OpenRouter models can be probed." };
  }
  const isPaidModel = Boolean(paidModel);
  const startedAt = Date.now();
  const response = await timedFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...config.headers },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "This is a connectivity check. Do not explain. Output only the requested short confirmation text." },
        { role: "user", content: "Reply with exactly: UXD_MODEL_CHECK_OK" }
      ],
      temperature: 0,
      // OpenRouter supports configurable reasoning effort for compatible models.
      // Keep probe reasoning minimal and leave enough room for a final text token sequence.
      reasoning: { effort: "minimal" },
      max_tokens: isPaidModel ? 128 : 256
    })
  }, 18000);
  if (!response.ok) {
    let providerMessage: string | undefined;
    let providerCode: string | number | undefined;
    try {
      const payload = await response.json() as {
        error?: { message?: unknown; code?: unknown };
        message?: unknown;
      };
      providerMessage = sanitizeProviderMessage(payload.error?.message ?? payload.message);
      if (typeof payload.error?.code === "string" || typeof payload.error?.code === "number") {
        providerCode = payload.error.code;
      }
    } catch {
      // Keep the HTTP status even when the upstream response is not JSON.
    }
    const quotaExhausted = model.endsWith(":free") && response.status === 429 &&
      /free-models-per-day|free model requests per day|add\s*10\s*credits/i.test(providerMessage ?? "");
    return {
      available: false, provider, model, status: response.status,
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(quotaExhausted ? { quotaExhausted: true, quotaType: "free-models-per-day" } : {}),
      reason: providerMessage ? `OpenRouter HTTP ${response.status}: ${providerMessage}` : `OpenRouter returned HTTP ${response.status}.`,
      latencyMs: Date.now() - startedAt
    };
  }
  const payload = await response.json() as {
    choices?: Array<{
      text?: unknown;
      finish_reason?: unknown;
      native_finish_reason?: unknown;
      error?: { message?: unknown; code?: unknown };
      message?: {
        content?: unknown;
        reasoning?: unknown;
        refusal?: unknown;
        tool_calls?: unknown;
      };
    }>;
    error?: { message?: unknown; code?: unknown };
    usage?: { completion_tokens?: unknown };
    model?: string;
  };
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const rawContent = message?.content ?? choice?.text;
  const content = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map(part => {
          if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
          return "";
        }).join("")
      : "";
  const responseReceived = content.trim().length > 0;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  const nativeFinishReason = typeof choice?.native_finish_reason === "string" ? choice.native_finish_reason : undefined;
  const choiceError = sanitizeProviderMessage(choice?.error?.message ?? payload.error?.message);
  const choiceErrorCode = choice?.error?.code ?? payload.error?.code;
  const messageFields = message ? Object.keys(message).filter(key => [
    "role", "content", "reasoning", "refusal", "tool_calls"
  ].includes(key)) : [];
  let reason: string | undefined;
  if (!responseReceived) {
    if (choiceError) {
      reason = "OpenRouter returned an error in the HTTP 200 response: " + choiceError;
    } else if (finishReason === "length" || nativeFinishReason === "length") {
      reason = "The model hit the 128-token probe limit before returning final text.";
    } else if (finishReason === "error" || nativeFinishReason === "error") {
      reason = "The provider reported a model-generation error despite HTTP 200.";
    } else if (typeof message?.reasoning === "string" && message.reasoning.trim()) {
      reason = "The model returned reasoning metadata but no final answer text.";
    } else {
      reason = "HTTP 200 had no usable text in message.content or choice.text.";
    }
  }
  return {
    available: responseReceived,
    provider,
    model,
    status: response.status,
    responseReceived,
    ...(finishReason ? { finishReason } : {}),
    ...(nativeFinishReason ? { nativeFinishReason } : {}),
    ...(messageFields.length ? { messageFields } : {}),
    ...(typeof choiceErrorCode === "string" || typeof choiceErrorCode === "number" ? { providerCode: choiceErrorCode } : {}),
    ...(typeof payload.usage?.completion_tokens === "number" ? { completionTokens: payload.usage.completion_tokens } : {}),
    ...(!responseReceived && reason ? { reason } : {}),
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Paid probes must use the shared gateway so the request is budget-checked and
 * recorded. Free probes remain a direct, single-model connectivity check.
 */
async function runSelectedModelProbe(provider: ProviderId, model: string) {
  if (!getOpenRouterPaidChatModel(model)) return probeModel(provider, model);
  const startedAt = Date.now();
  try {
    const result = await chatCompletionWithOpenRouterPaid({
      requestId: diagnosticId(),
      model,
      providerId: "openrouter",
      messages: [
        { role: "system", content: "This is a connectivity check. Output only the requested short confirmation text." },
        { role: "user", content: "Reply with exactly: UXD_PAID_MODEL_CHECK_OK" }
      ],
      temperature: 0,
      reasoning: { effort: "minimal" },
      max_tokens: 128
    }, { timeoutMs: 12000 });
    const responseReceived = typeof result.content === "string" && result.content.trim().length > 0;
    return {
      available: responseReceived,
      provider: "openrouter",
      model,
      status: 200,
      responseReceived,
      finishReason: responseReceived ? "response-received" : "empty-response",
      ...(typeof result.usage?.completion_tokens === "number" ? { completionTokens: result.usage.completion_tokens } : {}),
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    const status = error instanceof GatewayError
      ? error.status
      : (typeof error === "object" && error !== null && "status" in error &&
        typeof error.status === "number" && error.status >= 400 && error.status <= 599
        ? error.status : 502);
    const message = error instanceof Error ? error.message : "Paid OpenRouter probe failed.";
    return {
      available: false,
      provider: "openrouter",
      model,
      status,
      reason: sanitizeProviderMessage(message) ?? "Paid OpenRouter probe failed.",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    };
  }
}

async function discoverWorkingFreeModel() {
  const catalog = await discoverModels("openrouter");
  if (!catalog.configured || catalog.models.length === 0) {
    return { ...catalog, models: [] as string[], attempts: [] as Array<Record<string, unknown>> };
  }
  const candidates = catalog.models.slice(0, 5);
  const attempts: Array<{
    model: string;
    available: boolean;
    status?: number;
    providerCode?: string | number;
    reason?: string;
    quotaExhausted?: boolean;
    finishReason?: string;
    nativeFinishReason?: string;
    messageFields?: string[];
    completionTokens?: number;
    latencyMs?: number;
  }> = [];
  for (const model of candidates) {
    try {
      const result = await probeModel("openrouter", model);
      attempts.push({
        model, available: result.available,
        ...("status" in result && typeof result.status === "number" ? { status: result.status } : {}),
        ...("providerCode" in result && (typeof result.providerCode === "string" || typeof result.providerCode === "number") ? { providerCode: result.providerCode } : {}),
        ...("reason" in result && typeof result.reason === "string" ? { reason: result.reason } : {}),
        ...("quotaExhausted" in result && result.quotaExhausted === true ? { quotaExhausted: true } : {}),
        ...("finishReason" in result && typeof result.finishReason === "string" ? { finishReason: result.finishReason } : {}),
        ...("nativeFinishReason" in result && typeof result.nativeFinishReason === "string" ? { nativeFinishReason: result.nativeFinishReason } : {}),
        ...("messageFields" in result && Array.isArray(result.messageFields) ? { messageFields: result.messageFields.filter((field): field is string => typeof field === "string") } : {}),
        ...("completionTokens" in result && typeof result.completionTokens === "number" ? { completionTokens: result.completionTokens } : {}),
        ...("latencyMs" in result && typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {})
      });
      // This is an account-level free-tier quota, not a model-specific outage.
      // Stop here so discovery does not issue more completion requests against the same exhausted quota.
      if ("quotaExhausted" in result && result.quotaExhausted === true) {
        return {
          provider: "openrouter",
          configured: true,
          models: [],
          candidateCount: catalog.models.length,
          attemptedCount: attempts.length,
          attempts,
          quotaExhausted: true,
          quotaType: "free-models-per-day",
          reason: result.reason ?? "OpenRouter's daily free-model request quota is exhausted."
        };
      }
      if (result.available && "responseReceived" in result && result.responseReceived) {
        return {
          provider: "openrouter",
          configured: true,
          models: [model],
          selectedModel: model,
          checkedAt: new Date().toISOString(),
          probe: { available: true, latencyMs: result.latencyMs },
          attempts
        };
      }
    } catch (error) {
      attempts.push({
        model, available: false,
        reason: safeError(error),
      });
    }
  }
  return {
    provider: "openrouter", configured: true, models: [],
    candidateCount: catalog.models.length,
    attemptedCount: attempts.length,
    attempts,
    reason: "No tested :free model returned a usable chat response. Inspect attempts for each upstream HTTP status or error."
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET(request: Request) {
  const headers = corsHeaders();
  const id = diagnosticId();
  try {
    if (!originAllowed(request)) {
      return NextResponse.json({ error: "Origin not allowed.", diagnosticId: id }, { status: 403, headers });
    }
    const url = new URL(request.url);
    const fileKey = url.searchParams.get("fileKey");
    if (!approvedFileKey(request, fileKey) || (pluginOrigin(request) && !isAllowedFigmaFileKey(fileKey))) {
      return NextResponse.json({ error: "Approved Figma file key required.", diagnosticId: id }, { status: 403, headers });
    }
    const provider = url.searchParams.get("provider");
    const model = url.searchParams.get("model");
    if (provider && model) {
      if (provider !== "openrouter") {
        return NextResponse.json({ available: false, error: "Unsupported provider.", diagnosticId: id }, { status: 400, headers });
      }
      if (!getOpenRouterFreeChatModel(model)) {
        return NextResponse.json({
          available: false,
          error: "Direct probes are free-tier only. Approved paid models run only after the free-first chat router exhausts both free models.",
          diagnosticId: id
        }, { status: 400, headers });
      }
      // A direct health probe must never incur paid inference. Paid models can only
      // be invoked through chatCompletionFreeFirstThenPaid after both free models fail.
      const result = await runSelectedModelProbe(provider, model);
      return NextResponse.json({ ...result, probeVersion: "paid-probe-minimal-reasoning-store-timeouts-v1", diagnosticId: id }, { headers });
    }
    if (provider) {
      if (provider !== "openrouter") {
        return NextResponse.json({ error: "Unsupported provider.", diagnosticId: id }, { status: 400, headers });
      }
      const result = await discoverWorkingFreeModel();
      return NextResponse.json({ ...result, diagnosticId: id, note: "Discovery tests only the two approved free Nemotron models; paid fallback is selected separately by task expertise." }, { headers });
    }
    // Fetch the live catalog without probing every candidate. The plugin probes only
    // the user's selected model, avoiding multiple inference requests on startup.
    const result = await discoverModels("openrouter");
    const preferredOrder = [
      "nvidia/nemotron-3.5-lightning:free",
      "dots-studio/dots-3-note-preview:free",
      "apodex/apodex-1.1-mini:free"
    ];
    const rank = (modelId: string) => {
      const index = preferredOrder.indexOf(modelId);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const liveModelIds = [...result.models].sort((a, b) => {
      const rankDifference = rank(a) - rank(b);
      return rankDifference !== 0 ? rankDifference : a.localeCompare(b);
    }).slice(0, 80);
    const freeModels = OPENROUTER_FREE_CHAT_MODELS.map(model => ({
      provider: "openrouter", id: model.id, label: model.label,
      configured: result.configured, tier: "free-tier",
      listedInLiveCatalog: liveModelIds.includes(model.id)
    }));
    const verifiedPaidModels = "paidModels" in result && Array.isArray(result.paidModels) ? result.paidModels : [];
    const verifiedPaidById = new Map(verifiedPaidModels.map(model => [model.id, model]));
    // Always show all three approved paid models in the cockpit dropdown, but
    // disable any option whose exact live ID and positive price were not verified.
    const paidModels = OPENROUTER_PAID_CHAT_MODELS.map(model => {
      const verified = verifiedPaidById.get(model.id);
      if (verified) return verified;
      return {
        provider: "openrouter",
        id: model.id,
        label: model.label,
        configured: result.configured,
        tier: "paid",
        available: false,
        supportsImages: model.supportsImages,
        reason: ("reason" in result && typeof result.reason === "string" ? result.reason + " " : "") +
          "The exact live model ID and positive live pricing are not verified. This option remains visible but paid inference is blocked."
      };
    });
    const models = [...freeModels, ...paidModels];
    const selectedModel = freeModels[0]?.id ?? null;
    return NextResponse.json({
      models,
      selectedModel,
      provider: "openrouter",
      configured: result.configured,
      ...(!models.length ? { reason: ("reason" in result ? result.reason : undefined) ?? "No free OpenRouter models were returned by the live catalog." } : {}),
      checkedAt: result.checkedAt ?? new Date().toISOString(),
      diagnosticId: id,
      probeVersion: "paid-probe-minimal-reasoning-store-timeouts-v1",
      note: "Only the two approved free models and three allowlisted paid models are shown. Paid options are enabled only when the live catalogue and positive pricing are verified; selecting a paid option never sends a test inference."
    }, { headers });
  } catch (error) {
    console.error("[model-status] request failed", JSON.stringify({ diagnosticId: id, message: safeError(error) }));
    const timedOut = error instanceof Error && (error.name === "AbortError" || /timed out/i.test(error.message));
    return NextResponse.json({
      available: false,
      error: timedOut ? "Provider request timed out. This does not prove the API key is invalid." : "Model-status request failed.",
      reason: safeError(error),
      diagnosticId: id
    }, { status: timedOut ? 504 : 500, headers });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ available: false, error: "Request body must be valid JSON.", diagnosticId: diagnosticId() }, { status: 400, headers: corsHeaders() });
  }
  const parsed = body as { provider?: unknown; model?: unknown; fileKey?: unknown };
  const approvedFree = typeof parsed.model === "string" && Boolean(getOpenRouterFreeChatModel(parsed.model));
  const approvedPaid = typeof parsed.model === "string" && Boolean(getOpenRouterPaidChatModel(parsed.model));
  if (parsed.provider !== "openrouter" || typeof parsed.model !== "string" || typeof parsed.fileKey !== "string" ||
      (!approvedFree && !approvedPaid)) {
    return NextResponse.json({
      available: false,
      error: "A fileKey and an explicitly allowlisted OpenRouter model ID are required.",
      diagnosticId: diagnosticId()
    }, { status: 400, headers: corsHeaders() });
  }
  if (!originAllowed(request) || !approvedFileKey(request, parsed.fileKey) || !isAllowedFigmaFileKey(parsed.fileKey)) {
    return NextResponse.json({ available: false, error: "Origin or Figma file key not allowed.", diagnosticId: diagnosticId() }, { status: 403, headers: corsHeaders() });
  }
  // POST probes are only triggered by an explicit UI action. A paid probe
  // runs through the shared gateway, budget guard and usage ledger; GET never
  // sends paid inference. A successful paid probe may incur a small provider charge.
  try {
    return NextResponse.json({
      ...(await runSelectedModelProbe(parsed.provider, parsed.model)),
      probeKind: approvedPaid ? "explicit-budget-checked-paid-inference" : "free-connectivity-inference",
      diagnosticId: diagnosticId()
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ available: false, provider: parsed.provider, model: parsed.model, reason: safeError(error), diagnosticId: diagnosticId() }, { status: 502, headers: corsHeaders() });
  }
}
