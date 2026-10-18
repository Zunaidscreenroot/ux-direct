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

type OpenRouterModel = { id?: unknown; name?: unknown; context_length?: unknown };

function freeModelList(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray((payload as { data: unknown }).data)) return [];
  const rows = (payload as { data: OpenRouterModel[] }).data;
  const unique = new Map<string, { id: string; name: string; contextLength?: number }>();
  for (const row of rows) {
    if (typeof row?.id !== "string" || !row.id.endsWith(":free")) continue;
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*:free$/i.test(row.id)) continue;
    if (!unique.has(row.id)) unique.set(row.id, {
      id: row.id,
      name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
      ...(typeof row.context_length === "number" ? { contextLength: row.context_length } : {}),
    });
  }
  return Array.from(unique.values());
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(origin) });
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const auditBase = (process.env.UX_AUDIT_BASE_URL?.trim() || "https://uxaudit.zunaid-cb7.workers.dev").replace(/\/+$/, "");
  const [keyResult, modelsResult, auditResult, brainResult] = await Promise.allSettled([
    key ? fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: "Bearer " + key },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    }) : Promise.reject(new Error("OPENROUTER_API_KEY is not configured on the server.")),
    key ? fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
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

  let models: ReturnType<typeof freeModelList> = [];
  if (modelsResult.status === "fulfilled" && modelsResult.value.ok) {
    try { models = freeModelList(await modelsResult.value.json()); } catch { models = []; }
  }
  const preferred = [
    process.env.UX_DIRECT_CHAT_MODEL?.trim(),
    ...(process.env.OPENROUTER_MODELS || "").split(",").map((model) => model.trim()).filter(Boolean),
  ].filter((model): model is string => Boolean(model && model.endsWith(":free")));
  models.sort((a, b) => Number(preferred.includes(b.id)) - Number(preferred.includes(a.id)) || a.name.localeCompare(b.name));
  const maxVisible = models.slice(0, 40);
  const configuredDefault = preferred.find((model) => maxVisible.some((entry) => entry.id === model));
  const defaultModel = configuredDefault || maxVisible[0]?.id;
  const auditReachable = auditResult.status === "fulfilled" && auditResult.value.ok;
  const brainReachable = brainResult.status === "fulfilled" && brainResult.value.ok;
  const connected = keyOk && maxVisible.length > 0;
  return NextResponse.json({
    connected,
    provider: "OpenRouter",
    defaultModel,
    freeModels: maxVisible,
    checkedAt: new Date().toISOString(),
    ...(connected ? {} : { error: keyError || (models.length ? "No free models are available." : "No usable OpenRouter free models were returned.") }),
    uxAudit: { reachable: auditReachable, baseUrl: auditBase, ...(auditReachable ? {} : { error: "Could not reach the UX Audit Worker." }) },
    brain: { reachable: brainReachable, ...(brainReachable ? {} : { error: "Shared-brain health check failed or its server key is not configured." }) },
  }, { headers: corsHeaders(origin) });
}
