import { NextResponse } from "next/server";
import { z } from "zod";
import {
  chatCompletion,
  getFreeChatModelOptions,
  providersForFreeChat,
  providersFromEnv,
} from "@/src/model-gateway";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
// Keep provider/model probes explicit so checking one model never fans out API calls to every provider.
const modelKey = (provider: string, model: string) => provider + "::" + model;

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
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown model-status error.";
  return message.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]").slice(0, 220);
}
function diagnosticId() {
  return `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function logFailure(id: string, stage: string, error: unknown, provider?: string, model?: string) {
  console.error("[model-status] request failed", JSON.stringify({
    diagnosticId: id,
    stage,
    provider,
    model,
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: safeError(error)
  }));
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.has("provider") || url.searchParams.has("model")) {
    return handleModelProbe(request, {
      fileKey: url.searchParams.get("fileKey"),
      provider: url.searchParams.get("provider"),
      model: url.searchParams.get("model")
    });
  }

  const headers = corsHeaders();
  const id = diagnosticId();
  let stage = "request-validation";
  try {
    if (!originAllowed(request)) {
      return NextResponse.json({ error: "Origin not allowed.", diagnosticId: id }, { status: 403, headers });
    }
    const fileKey = url.searchParams.get("fileKey");
    if (!approvedFileKey(request, fileKey)) {
      return NextResponse.json({ error: "Approved Figma file key required.", diagnosticId: id }, { status: 403, headers });
    }

    stage = "provider-configuration";
    const providers = providersFromEnv();
    const configuredOptions = getFreeChatModelOptions(providers);
    return NextResponse.json({
      models: configuredOptions,
      checkedAt: new Date().toISOString(),
      diagnosticId: id,
      note: "This response lists configuration only. To test live availability, pass provider, model and fileKey."
    }, { headers });
  } catch (error) {
    logFailure(id, stage, error);
    return NextResponse.json({
      error: "Model-status configuration check failed.",
      diagnosticId: id,
      stage,
      detail: safeError(error)
    }, { status: 500, headers });
  }
}

const probeSchema = z.object({
  fileKey: z.string().trim().min(1).max(200),
  provider: z.enum(["gemini", "openrouter"]),
  model: z.string().trim().min(1).max(180)
});

async function handleModelProbe(request: Request, raw: unknown) {
  const headers = corsHeaders();
  const id = diagnosticId();
  const startedAt = Date.now();
  let stage = "request-validation";
  let providerName: string | undefined;
  let modelName: string | undefined;

  try {
    if (!originAllowed(request)) {
      return NextResponse.json({ available: false, error: "Origin not allowed.", diagnosticId: id }, { status: 403, headers });
    }

    const parsed = probeSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ available: false, error: "A valid model, provider and approved file key are required.", diagnosticId: id }, { status: 400, headers });
    }
    const { fileKey, provider, model } = parsed.data;
    providerName = provider;
    modelName = model;

    if (!approvedFileKey(request, fileKey) || !isAllowedFigmaFileKey(fileKey)) {
      return NextResponse.json({ available: false, error: "Approved Figma file key required.", diagnosticId: id }, { status: 403, headers });
    }

    stage = "model-allowlist";
    const allowedModels = getFreeChatModelOptions();
    if (!allowedModels.some(item => modelKey(item.provider, item.id) === modelKey(provider, model))) {
      return NextResponse.json({ available: false, provider, model, error: "This model is not in the approved free-model list.", diagnosticId: id }, { status: 400, headers });
    }

    stage = "provider-configuration";
    const providers = providersForFreeChat(providersFromEnv());
    const configuredProvider = providers.find(item => item.name === provider &&
      (provider === "gemini" ? item.kind === "free-tier" && Boolean(item.apiKey) : Boolean(item.apiKey)) &&
      item.models.includes(model));

    if (!configuredProvider) {
      return NextResponse.json({
        available: false, provider, model,
        reason: provider === "gemini" ? "Gemini API key or free-tier model access is not configured in this Preview." : "OpenRouter API key is not configured in this Preview.",
        diagnosticId: id,
        checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt
      }, { headers });
    }

    stage = "live-provider-call";
    // Bound the entire probe so slow gateway initialization/provider responses return JSON
    // before the browser or Preview request goes idle. Keep this probe tiny and single-provider.
    const probePromise = chatCompletion({
      model,
      providerId: provider,
      messages: [{ role: "user", content: "Reply with exactly: UXD_MODEL_CHECK_OK" }],
      temperature: 0,
      max_tokens: 12
    }, { providers, timeoutMs: 8000 });
    const result = await Promise.race([
      probePromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Live model probe timed out after 9 seconds.")), 9000);
      })
    ]);

    if (!result.content || !result.content.trim()) {
      return NextResponse.json({
        available: false, provider, model,
        reason: "The provider returned an empty response.",
        diagnosticId: id,
        checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt
      }, { headers });
    }
    return NextResponse.json({
      available: true, provider, model, checkedAt: new Date().toISOString(),
      diagnosticId: id,
      latencyMs: Date.now() - startedAt,
      responseReceived: true
    }, { headers });
  } catch (error) {
    logFailure(id, stage, error, providerName, modelName);
    return NextResponse.json({
      available: false,
      provider: providerName,
      model: modelName,
      reason: safeError(error),
      diagnosticId: id,
      stage,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt
    }, { status: 500, headers });
  }
}

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ available: false, error: "Request body must be valid JSON.", diagnosticId: diagnosticId() }, { status: 400, headers: corsHeaders() });
  }
  return handleModelProbe(request, raw);
}
