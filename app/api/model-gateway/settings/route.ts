import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getModelCatalog, providersFromEnv } from "@/src/model-gateway";
import { getLiveGatewayModels } from "@/src/model-gateway/openrouter-catalog";
import { GATEWAY_MODULES, getGatewaySettings, getDefaultModelPolicy, modelKey, saveGatewaySettings } from "@/src/model-gateway/control-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function jsonError(message: string, status: number) { return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } }); }
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin && request.headers.get("sec-fetch-site") !== "cross-site");
}
function matchesSecret(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function localSettingsWritesAllowed(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return process.env.NODE_ENV !== "production" &&
    process.env.MODEL_GATEWAY_ALLOW_UNAUTHENTICATED_LOCAL === "true" &&
    ["localhost", "127.0.0.1", "::1"].includes(hostname);
}
export async function GET() {
  return NextResponse.json({ settings: await getGatewaySettings(), modules: GATEWAY_MODULES }, { headers: { "Cache-Control": "no-store" } });
}
export async function PUT(request: Request) {
  if (!sameOrigin(request)) return jsonError("Cross-origin or non-browser gateway setting changes are not allowed.", 403);
  const expectedAdminKey = process.env.MODEL_GATEWAY_ADMIN_KEY;
  if (expectedAdminKey) {
    if (!matchesSecret(request.headers.get("x-model-gateway-admin-key"), expectedAdminKey)) {
      return jsonError("Invalid gateway settings admin key.", 401);
    }
  } else if (!localSettingsWritesAllowed(request)) {
    return jsonError("Gateway settings are read-only until MODEL_GATEWAY_ADMIN_KEY is configured on the server.", 503);
  }
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) return jsonError("Send gateway settings as application/json.", 415);
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("Invalid JSON settings payload.", 400); }
  if (!body || typeof body !== "object") return jsonError("A settings object is required.", 400);
  const input = body as Record<string, unknown>;
  const rawModules = input.modules && typeof input.modules === "object" ? input.modules as Record<string, unknown> : {};
  const rawModels = input.models && typeof input.models === "object" ? input.models as Record<string, unknown> : {};
  const providers = providersFromEnv();
  let catalog = getModelCatalog(providers);
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const live = await getLiveGatewayModels();
      catalog = [...catalog.filter(model => model.provider !== "openrouter"), ...live.models];
    } catch {
      // Existing settings can still be read during a temporary catalog outage, but
      // a newly-added model must exist in the last available catalog to be saved.
    }
  }
  const allowed = new Set(catalog.map(m => modelKey(m.provider, m.id)));
  for (const def of GATEWAY_MODULES) {
    const rawModule = rawModules[def.id];
    if (!rawModule || typeof rawModule !== "object" || Array.isArray(rawModule)) return jsonError("Missing module settings: " + def.id, 400);
    const m = rawModule as Record<string, unknown>;
    if (!["free", "paid", "local", "mock"].includes(String(m.mode))) return jsonError("Invalid routing mode for " + def.id, 400);
    const selected = typeof m.selectedModelKey === "string" ? m.selectedModelKey : "";
    if (selected !== "auto" && !allowed.has(selected)) return jsonError("Unknown selected model for " + def.id, 400);
    if (selected !== "auto") {
      const entry = catalog.find(model => modelKey(model.provider, model.id) === selected)!;
      if (m.mode === "local" && entry.tier !== "local") return jsonError("Local mode requires a local model: " + def.id, 400);
      if (m.mode === "mock" && entry.tier !== "mock") return jsonError("Mock mode requires the deterministic mock model: " + def.id, 400);
      if (m.mode === "free" && entry.tier !== "free-tier" && !entry.id.endsWith(":free")) return jsonError("Free mode only accepts models with a free-tier route: " + def.id, 400);
      if (m.mode === "paid" && (entry.tier === "local" || entry.tier === "mock" || entry.id.endsWith(":free"))) return jsonError("Paid mode requires a billable API model: " + def.id, 400);
    }
  }
  if (Object.keys(rawModels).length > catalog.length + 10) return jsonError("Too many model budget entries.", 413);
  for (const [key, rawModel] of Object.entries(rawModels)) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) return jsonError("Invalid model budget entry: " + key, 400);
    // Ignore legacy model-budget rows from previously connected providers; only live OpenRouter IDs are retained below.
    if (!allowed.has(key)) continue;
    const model = rawModel as Record<string, unknown>;
    for (const field of ["monthlyBudgetInr", "maxRequestCostInr", "inputPriceInrPerMillion", "outputPriceInrPerMillion"]) {
      const n = Number(model[field]);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return jsonError("Invalid " + field + " for " + key, 400);
    }
  }
  const current = await getGatewaySettings();
  const models: Record<string, unknown> = { ...current.models };
  for (const m of catalog) {
    const key = modelKey(m.provider, m.id);
    const proposed = rawModels[key];
    if (proposed) {
      const p = proposed as Record<string, unknown>;
      models[key] = { monthlyBudgetInr: Number(p.monthlyBudgetInr), maxRequestCostInr: Number(p.maxRequestCostInr), inputPriceInrPerMillion: Number(p.inputPriceInrPerMillion), outputPriceInrPerMillion: Number(p.outputPriceInrPerMillion) };
    } else if (!models[key]) models[key] = getDefaultModelPolicy(m.provider, m.id, m.usdInputPerMillion ?? 0, m.usdOutputPerMillion ?? 0, Number(input.usdToInrRate) || 97);
  }
  const saved = await saveGatewaySettings({ ...input, models });
  return NextResponse.json({ ok: true, settings: saved }, { headers: { "Cache-Control": "no-store" } });
}
