import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin && ALLOWED_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "Figma plugin origin required." }, { status: 403, headers: corsHeaders(origin) });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(origin) });
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const auditBase = (process.env.UX_AUDIT_BASE_URL?.trim() || "https://uxaudit.zunaid-cb7.workers.dev").replace(/\/+$/, "");
  const [keyResult, auditResult, brainResult] = await Promise.allSettled([
    key ? fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: "Bearer " + key },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    }) : Promise.reject(new Error("OPENROUTER_API_KEY is not configured on the server.")),
    fetch(auditBase + "/", { cache: "no-store", signal: AbortSignal.timeout(5000) }),
    process.env.UX_DIRECT_BRAIN_API_KEY ? fetch(new URL("/api/brain/health", process.env.UX_DIRECT_PUBLIC_URL || "https://ux-direct.zunaid-cb7.workers.dev"), {
      headers: { Authorization: "Bearer " + process.env.UX_DIRECT_BRAIN_API_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    }) : Promise.reject(new Error("Shared-brain API key is not configured.")),
  ]);

  let keyOk = false;
  let keyError = "";
  if (keyResult.status === "fulfilled") {
    keyOk = keyResult.value.ok;
    if (!keyOk) keyError = "OpenRouter rejected the configured API key (HTTP " + keyResult.value.status + ").";
  } else keyError = keyResult.reason instanceof Error ? keyResult.reason.message : "OpenRouter key check failed.";

  const auditReachable = auditResult.status === "fulfilled" && auditResult.value.ok;
  const brainReachable = brainResult.status === "fulfilled" && brainResult.value.ok;
  let brainDiagnostics: Record<string, unknown> = {};
  if (brainReachable && brainResult.status === "fulfilled") {
    try {
      const payload = await brainResult.value.json() as Record<string, unknown>;
      brainDiagnostics = {
        ...(payload.retrievalRegressionTests && typeof payload.retrievalRegressionTests === "object"
          ? { retrievalRegressionTests: payload.retrievalRegressionTests }
          : {}),
        ...(typeof payload.semanticVectorSearch === "string" ? { semanticVectorSearch: payload.semanticVectorSearch } : {}),
      };
    } catch {
      brainDiagnostics = {};
    }
  }
  const connected = keyOk;
  return NextResponse.json({
    connected,
    provider: "OpenRouter",
    defaultModel: "openai/gpt-6-luna",
    fallbackModel: "openrouter/auto",
    models: [
      { id: "openai/gpt-6-luna", name: "GPT-6 Luna · primary" },
      { id: "openrouter/auto", name: "OpenRouter Auto · fallback" },
    ],
    checkedAt: new Date().toISOString(),
    ...(connected ? {} : { error: keyError || "OpenRouter is not ready for Auto Router requests." }),
    uxAudit: { reachable: auditReachable, baseUrl: auditBase, ...(auditReachable ? {} : { error: "Could not reach the UX Audit Worker." }) },
    brain: { reachable: brainReachable, ...brainDiagnostics, ...(brainReachable ? {} : { error: "Shared-brain health check failed or its server key is not configured." }) },
  }, { headers: corsHeaders(origin) });
}
