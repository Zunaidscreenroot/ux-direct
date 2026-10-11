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
function providerConfig(provider: ProviderId) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return apiKey ? {
    apiKey,
    baseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\\/+$/, ""),
    modelsUrl: "https://openrouter.ai/api/v1/models",
    headers: { Authorization: `Bearer ${apiKey}` }
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
  let models: string[];
  models = (payload.data ?? [])
    .filter(item => typeof item.id === "string" && item.id.endsWith(":free"))
    .map(item => item.id)
    .filter((id): id is string => Boolean(id));
  return { provider, configured: true, models, checkedAt: new Date().toISOString() };
}
async function probeModel(provider: ProviderId, model: string) {
  const config = providerConfig(provider);
  if (!config) return { available: false, provider, model, reason: `${provider} API key is missing in this deployment context.` };
  const startedAt = Date.now();
  const response = await timedFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(provider === "gemini" ? { Authorization: `Bearer ${config.apiKey}` } : config.headers) },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: UXD_MODEL_CHECK_OK" }],
      temperature: 0,
      max_tokens: 12
    })
  }, 18000);
  if (!response.ok) {
    const status = response.status;
    // Do not forward provider response bodies; they can contain account details.
    return { available: false, provider, model, reason: `Provider returned HTTP ${status}.`, latencyMs: Date.now() - startedAt };
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; model?: string };
  const content = payload.choices?.[0]?.message?.content;
  return {
    available: typeof content === "string" && content.trim().length > 0,
    provider,
    model,
    responseReceived: typeof content === "string" && content.trim().length > 0,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString()
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
      // Probe exactly one requested model; no fallback and no fan-out to other providers.
      const result = await probeModel(provider, model);
      return NextResponse.json({ ...result, diagnosticId: id }, { headers });
    }
    if (provider) {
      if (provider !== "openrouter") {
        return NextResponse.json({ error: "Unsupported provider.", diagnosticId: id }, { status: 400, headers });
      }
      const result = await discoverModels(provider);
      return NextResponse.json({ ...result, diagnosticId: id, note: "Models are fetched live from the provider API; no static model allowlist is used by this endpoint." }, { headers });
    }
    // One lightweight catalog request per configured provider; no inference calls during discovery.
    const results = await Promise.allSettled([discoverModels("openrouter")]);
    const providers = results.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { provider: "openrouter", configured: Boolean(providerConfig(index === 0 ? "gemini" : "openrouter")), models: [], reason: safeError(result.reason) });
    const models = providers.flatMap(entry => entry.models.map(modelId => ({ provider: "openrouter", id: modelId, label: modelId + " · Free", configured: entry.configured, tier: "free-tier" })));
    return NextResponse.json({ models, providers, checkedAt: new Date().toISOString(), diagnosticId: id, note: "Models are discovered live from provider APIs. OpenRouter is restricted to model IDs marked :free; Only OpenRouter model IDs marked :free are returned." }, { headers });
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
  if ((parsed.provider !== "gemini" && parsed.provider !== "openrouter") || typeof parsed.model !== "string" || typeof parsed.fileKey !== "string") {
    return NextResponse.json({ available: false, error: "Valid provider, model and fileKey are required.", diagnosticId: diagnosticId() }, { status: 400, headers: corsHeaders() });
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
