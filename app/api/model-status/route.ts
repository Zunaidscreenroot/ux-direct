import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import {
  callOpenRouterChat,
  checkPluginRateLimit,
  getPluginModelList,
  isAllowedPluginOrigin,
  pluginCorsHeaders,
  PluginOpenRouterError,
} from "@/src/figma/plugin-ai-api";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(request: Request, value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: pluginCorsHeaders(request) });
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: pluginCorsHeaders(request) });
}

export async function GET(request: Request) {
  if (!isAllowedPluginOrigin(request)) return json(request, { error: "Origin not allowed." }, 403);
  const url = new URL(request.url);
  const fileKey = url.searchParams.get("fileKey");
  if (!isAllowedFigmaFileKey(fileKey)) {
    return json(request, { error: "Figma file is not allowlisted." }, 403);
  }

  const provider = url.searchParams.get("provider");
  const modelId = url.searchParams.get("model");
  if (!provider && !modelId) {
    const models = getPluginModelList();
    return json(request, {
      models,
      selectedModel: models.find((model) => model.tier === "free-tier" && model.available)?.id ?? null,
      checkedAt: new Date().toISOString(),
    });
  }
  if (provider !== "openrouter" || !modelId) {
    return json(request, { available: false, responseReceived: false, reason: "Choose an approved OpenRouter model." }, 400);
  }

  const model = getPluginModelList().find((entry) => entry.id === modelId);
  if (!model || !model.available) {
    return json(request, {
      available: false,
      responseReceived: false,
      reason: "The selected OpenRouter model is not configured in this deployment.",
      checkedAt: new Date().toISOString(),
    });
  }

  const limit = checkPluginRateLimit(request);
  if (!limit.allowed) {
    return json(request, {
      available: false,
      responseReceived: false,
      reason: "Plugin model checks are rate limited. Retry in " + limit.retryAfterSeconds + " seconds.",
      status: 429,
      checkedAt: new Date().toISOString(),
    }, 200);
  }

  try {
    if (model.tier === "paid") {
      return json(request, {
        available: true,
        responseReceived: false,
        paidTestRequired: true,
        reason: "Paid model is selectable. Use the explicit Test button to verify real inference; a small API charge may apply.",
        checkedAt: new Date().toISOString(),
      });
    }
    const result = await callOpenRouterChat(modelId, [{ role: "user", content: "Reply with exactly OK." }], {
      maxTokens: 128,
      temperature: 0,
      timeoutMs: 15000,
    });
    return json(request, {
      available: true,
      responseReceived: true,
      status: 200,
      latencyMs: result.latencyMs,
      provider: "openrouter",
      model: result.model,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status = error instanceof PluginOpenRouterError ? error.status : 502;
    const reason = error instanceof Error ? error.message : "OpenRouter check failed.";
    return json(request, {
      available: false,
      responseReceived: false,
      status,
      quotaExhausted: model.tier === "free-tier" && status === 429,
      reason,
      checkedAt: new Date().toISOString(),
    });
  }
}

export async function POST(request: Request) {
  if (!isAllowedPluginOrigin(request)) return json(request, { error: "Origin not allowed." }, 403);
  let parsed: unknown;
  try { parsed = await request.json(); }
  catch { return json(request, { available: false, responseReceived: false, reason: "Request body must be JSON." }, 400); }
  if (!isRecord(parsed)) return json(request, { available: false, responseReceived: false, reason: "Request body must be a JSON object." }, 400);
  const body = parsed;
  if (typeof body.fileKey !== "string" || !isAllowedFigmaFileKey(body.fileKey)) {
    return json(request, { available: false, responseReceived: false, reason: "Figma file is not allowlisted." }, 403);
  }
  const provider = body.provider;
  const modelId = body.model;
  if (provider !== "openrouter" || typeof modelId !== "string") {
    return json(request, { available: false, responseReceived: false, reason: "Choose an approved OpenRouter paid model." }, 400);
  }
  const model = getPluginModelList().find((entry) => entry.id === modelId);
  if (!model || model.tier !== "paid" || !model.available) {
    return json(request, { available: false, responseReceived: false, reason: "The requested paid model is not enabled." }, 403);
  }
  const limit = checkPluginRateLimit(request);
  if (!limit.allowed) {
    return json(request, {
      available: false,
      responseReceived: false,
      reason: "Plugin model tests are rate limited. Retry in " + limit.retryAfterSeconds + " seconds.",
      checkedAt: new Date().toISOString(),
    }, 429);
  }
  try {
    const result = await callOpenRouterChat(modelId, [{ role: "user", content: "Reply with exactly OK." }], {
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 15000,
    });
    return json(request, {
      available: true,
      responseReceived: true,
      provider: "openrouter",
      model: result.model,
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status = error instanceof PluginOpenRouterError ? error.status : 502;
    return json(request, {
      available: false,
      responseReceived: false,
      reason: error instanceof Error ? error.message : "Paid model test failed.",
      checkedAt: new Date().toISOString(),
    }, status >= 400 && status <= 599 ? status : 502);
  }
}
