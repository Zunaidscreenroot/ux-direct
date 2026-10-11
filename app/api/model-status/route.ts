import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { getOpenRouterPaidChatModel, OPENROUTER_PAID_CHAT_MODELS } from "@/src/model-gateway/openrouter-paid";

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
  const models: string[] = (payload.data ?? [])
    .filter(item => typeof item.id === "string" && item.id.endsWith(":free"))
    .map(item => item.id)
    .filter((id): id is string => Boolean(id));
  const paidModels = OPENROUTER_PAID_CHAT_MODELS.flatMap(model => {
    const live = (payload.data ?? []).find(item => item.id === model.id);
    const liveInputPrice = Number(live?.pricing?.prompt);
    const liveOutputPrice = Number(live?.pricing?.completion);
    // Never list the paid model unless OpenRouter's live catalog confirms both prices.
    if (!live || !(liveInputPrice > 0) || !(liveOutputPrice > 0)) return [];
    return [{
      provider: "openrouter",
      id: model.id,
      label: model.label + " · $" + model.listedInputUsdPerMillion.toFixed(2) + " in / $" + model.listedOutputUsdPerMillion.toFixed(2) + " out per 1M",
      configured: true,
      tier: "paid",
      listedInputUsdPerMillion: model.listedInputUsdPerMillion,
      listedOutputUsdPerMillion: model.listedOutputUsdPerMillion,
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
  if (!model.endsWith(":free") && !paidModel) {
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
      if (!model.endsWith(":free") && !getOpenRouterPaidChatModel(model)) {
        return NextResponse.json({
          available: false, error: "Only free IDs or explicitly allowlisted low-cost paid OpenRouter models can be probed.", diagnosticId: id
        }, { status: 400, headers });
      }
      // Probe only the explicitly selected model. Paid probes are restricted to the
      // server-side allowlist and use a 128-token response cap.
      const result = await probeModel(provider, model);
      return NextResponse.json({ ...result, diagnosticId: id }, { headers });
    }
    if (provider) {
      if (provider !== "openrouter") {
        return NextResponse.json({ error: "Unsupported provider.", diagnosticId: id }, { status: 400, headers });
      }
      const result = await discoverWorkingFreeModel();
      return NextResponse.json({ ...result, diagnosticId: id, note: "Models are fetched live from the provider API; no static model allowlist is used by this endpoint." }, { headers });
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
    const freeModels = liveModelIds.map(modelId => ({
      provider: "openrouter", id: modelId, label: modelId + " · Free",
      configured: result.configured, tier: "free-tier"
    }));
    const paidModels = "paidModels" in result && Array.isArray(result.paidModels) ? result.paidModels : [];
    // Prefer the explicitly allowlisted paid model while the user is in paid-model testing mode.
    const models = [...paidModels, ...freeModels];
    const selectedModel = paidModels[0]?.id ?? freeModels.find(model => model.id === preferredOrder[0])?.id ?? freeModels[0]?.id ?? null;
    return NextResponse.json({
      models,
      selectedModel,
      provider: "openrouter",
      configured: result.configured,
      ...(!models.length ? { reason: ("reason" in result ? result.reason : undefined) ?? "No free OpenRouter models were returned by the live catalog." } : {}),
      checkedAt: result.checkedAt ?? new Date().toISOString(),
      diagnosticId: id,
      note: "Free model IDs and the allowlisted paid model are verified against OpenRouter live catalog pricing. The plugin probes only the selected model before enabling chat."
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
  if (parsed.provider !== "openrouter" || typeof parsed.model !== "string" || typeof parsed.fileKey !== "string" ||
      (!parsed.model.endsWith(":free") && !getOpenRouterPaidChatModel(parsed.model))) {
    return NextResponse.json({ available: false, error: "A free OpenRouter model or allowlisted paid model ID and fileKey are required.", diagnosticId: diagnosticId() }, { status: 400, headers: corsHeaders() });
  }
  if (!originAllowed(request) || !approvedFileKey(request, parsed.fileKey) || !isAllowedFigmaFileKey(parsed.fileKey)) {
    return NextResponse.json({ available: false, error: "Origin or Figma file key not allowed.", diagnosticId: diagnosticId() }, { status: 403, headers: corsHeaders() });
  }
  try {
    return NextResponse.json({ ...(await probeModel(parsed.provider, parsed.model)), diagnosticId: diagnosticId() }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ available: false, provider: parsed.provider, model: parsed.model, reason: safeError(error), diagnosticId: diagnosticId() }, { status: 502, headers: corsHeaders() });
  }
}
