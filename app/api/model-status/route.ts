import { NextResponse } from "next/server";
import { z } from "zod";
import {
  chatCompletion,
  getFreeChatModelOptions,
  providersForFreeChat,
  providersFromEnv,
  type FreeChatModel
} from "@/src/model-gateway";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
const MODEL_PAIRS = new Set<string>();
const modelKey = (provider: string, model: string) => provider + "::" + model;
const freeModels = getFreeChatModelOptions();
for (const model of freeModels) MODEL_PAIRS.add(modelKey(model.provider, model.id));

function corsHeaders() {
  return {
    // Figma plugin iframes use an opaque "null" origin and require wildcard CORS.
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
  const message = error instanceof Error ? error.message : "Model probe failed.";
  return message.slice(0, 220);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET(request: Request) {
  const headers = corsHeaders();
  if (!originAllowed(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  }
  const url = new URL(request.url);
  const fileKey = url.searchParams.get("fileKey");
  if (!approvedFileKey(request, fileKey)) {
    return NextResponse.json({ error: "Approved Figma file key required." }, { status: 403, headers });
  }
  const providers = providersFromEnv();
  const configuredOptions = getFreeChatModelOptions(providers);
  return NextResponse.json({
    models: configuredOptions,
    checkedAt: new Date().toISOString(),
    note: "A model is marked connected only after a live probe receives a non-empty model response."
  }, { headers });
}

const probeSchema = z.object({
  fileKey: z.string().trim().min(1).max(200),
  provider: z.enum(["gemini", "openrouter"]),
  model: z.string().trim().min(1).max(180)
});

export async function POST(request: Request) {
  const headers = corsHeaders();
  if (!originAllowed(request)) {
    return NextResponse.json({ available: false, error: "Origin not allowed." }, { status: 403, headers });
  }

  let raw: unknown;
  try { raw = await request.json(); }
  catch { return NextResponse.json({ available: false, error: "Request body must be valid JSON." }, { status: 400, headers }); }

  const parsed = probeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ available: false, error: "A valid model, provider and approved file key are required." }, { status: 400, headers });
  }
  const { fileKey, provider, model } = parsed.data;
  if (!approvedFileKey(request, fileKey) || !isAllowedFigmaFileKey(fileKey)) {
    return NextResponse.json({ available: false, error: "Approved Figma file key required." }, { status: 403, headers });
  }
  if (!MODEL_PAIRS.has(modelKey(provider, model))) {
    return NextResponse.json({ available: false, error: "This model is not in the approved free-model list." }, { status: 400, headers });
  }

  const startedAt = Date.now();
  const providers = providersForFreeChat(providersFromEnv());
  const configuredProvider = providers.find(item => item.name === provider &&
    (provider === "gemini" ? item.kind === "free-tier" && Boolean(item.apiKey) : Boolean(item.apiKey)) &&
    item.models.includes(model));

  if (!configuredProvider) {
    return NextResponse.json({
      available: false, provider, model,
      reason: provider === "gemini" ? "Gemini API key or free-tier model access is not configured in this Preview." : "OpenRouter API key is not configured in this Preview.",
      checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt
    }, { headers });
  }

  try {
    const result = await chatCompletion({
      model,
      providerId: provider,
      messages: [{ role: "user", content: "Reply with exactly: UXD_MODEL_CHECK_OK" }],
      temperature: 0,
      max_tokens: 12
    }, { providers, timeoutMs: 15000 });

    if (!result.content || !result.content.trim()) {
      return NextResponse.json({
        available: false, provider, model,
        reason: "The provider returned an empty response.",
        checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt
      }, { headers });
    }
    return NextResponse.json({
      available: true, provider, model, checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      responseReceived: true
    }, { headers });
  } catch (error) {
    return NextResponse.json({
      available: false, provider, model,
      reason: safeError(error),
      checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt
    }, { headers });
  }
}
