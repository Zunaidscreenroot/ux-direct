import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";

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
  return { provider, configured: true, models, checkedAt: new Date().toISOString() };
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
  if (!model.endsWith(":free")) {
    return { available: false, provider, model, status: 400, reason: "Only model IDs ending in :free can be probed by this endpoint." };
  }
  const startedAt = Date.now();
  const response = await timedFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...config.headers },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: UXD_MODEL_CHECK_OK" }],
      temperature: 0,
      // Reasoning-oriented free models can spend more than 12 tokens thinking
      // before producing the tiny confirmation text. Keep a modest hard cap.
      max_tokens: 128
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
    return {
      available: false, provider, model, status: response.status,
      ...(providerCode === undefined ? {} : { providerCode }),
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
      reason = \`OpenRouter returned an error in the HTTP 200 response: \${choiceError}\`;
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
  const attempts: Array<{ model: string; available: boolean; status?: number; providerCode?: string | number; reason?: string; latencyMs?: number }> = [];
  for (const model of candidates) {
    try {
      const result = await probeModel("openrouter", model);
      attempts.push({
        model, available: result.available,
        ...("status" in result && typeof result.status === "number" ? { status: result.status } : {}),
        ...("providerCode" in result && (typeof result.providerCode === "string" || typeof result.providerCode === "number") ? { providerCode: result.providerCode } : {}),
        ...("reason" in result && typeof result.reason === "string" ? { reason: result.reason } : {}),
        ...("latencyMs" in result && typeof result.latencyMs === "number" ? { latencyMs: result.latencyMs } : {})
      });
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
      if (!model.endsWith(":free")) {
        return NextResponse.json({
          available: false, error: "Only model IDs ending in :free can be probed by this endpoint.", diagnosticId: id
        }, { status: 400, headers });
      }
      // Probe exactly one requested free model; no paid IDs, fallback, or provider fan-out.
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
    // Discover current free models and return only the first model that passed a real response probe.
    const result = await discoverWorkingFreeModel();
    const models = result.models.map(modelId => ({
      provider: "openrouter", id: modelId, label: modelId + " · Free",
      configured: result.configured, tier: "free-tier"
    }));
    return NextResponse.json({
      models,
      selectedModel: result.selectedModel ?? null,
      probe: result.probe ?? { available: false },
      provider: "openrouter",
      configured: result.configured,
      reason: result.reason,
      checkedAt: result.checkedAt ?? new Date().toISOString(),
      diagnosticId: id,
      note: "Models are fetched live from OpenRouter; only the first free model returning a real response is selected."
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
  if (parsed.provider !== "openrouter" || typeof parsed.model !== "string" || typeof parsed.fileKey !== "string" || !parsed.model.endsWith(":free")) {
    return NextResponse.json({ available: false, error: "A valid OpenRouter :free model ID and fileKey are required.", diagnosticId: diagnosticId() }, { status: 400, headers: corsHeaders() });
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
