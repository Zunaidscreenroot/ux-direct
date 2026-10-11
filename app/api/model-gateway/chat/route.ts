import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { chatCompletionWithFallback, GatewayError, type ChatMessage } from "@/src/model-gateway";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";
import { GATEWAY_MODULES } from "@/src/model-gateway/control-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const key = process.env.MODEL_GATEWAY_ACCESS_KEY;
  if (key) {
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      request.headers.get("x-model-gateway-key");
    return Boolean(supplied && supplied.length === key.length &&
      supplied.split("").reduce((n, c, i) => n | (c.charCodeAt(0) ^ key.charCodeAt(i)), 0) === 0);
  }
  // Safe local-only escape hatch; never enabled in production.
  const url = new URL(request.url);
  const host = url.hostname;
  return process.env.NODE_ENV !== "production" &&
    process.env.MODEL_GATEWAY_ALLOW_UNAUTHENTICATED_LOCAL === "true" &&
    ["localhost", "127.0.0.1", "::1"].includes(host);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({
      error: process.env.MODEL_GATEWAY_ACCESS_KEY
        ? "Unauthorized model gateway request."
        : "Gateway is locked. Set MODEL_GATEWAY_ACCESS_KEY; unauthenticated access is disabled."
    }, { status: process.env.MODEL_GATEWAY_ACCESS_KEY ? 401 : 503, headers: { "Cache-Control": "no-store" } });
  }
  const ip = request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Gateway request rate limit exceeded.", retryAfterSeconds: limit.retryAfterSeconds }, {
      status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(limit.retryAfterSeconds), "X-RateLimit-Limit": String(limit.limit), "X-RateLimit-Remaining": String(limit.remaining) }
    });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  if (typeof value.model !== "string" || !Array.isArray(value.messages)) {
    return NextResponse.json({ error: "Required fields: model (string), messages (array)." }, { status: 400 });
  }
  if (value.messages.length < 1 || value.messages.length > 100) {
    return NextResponse.json({ error: "messages must contain between 1 and 100 entries." }, { status: 400 });
  }
  const messages: ChatMessage[] = [];
  for (const item of value.messages) {
    if (!item || typeof item !== "object") return NextResponse.json({ error: "Invalid message entry." }, { status: 400 });
    const message = item as Record<string, unknown>;
    if (!["system", "user", "assistant"].includes(String(message.role)) || typeof message.content !== "string") {
      return NextResponse.json({ error: "Each message requires a supported role and string content." }, { status: 400 });
    }
    messages.push({ role: message.role as ChatMessage["role"], content: message.content });
  }
  if (value.moduleId !== undefined && (typeof value.moduleId !== "string" || !GATEWAY_MODULES.some(module => module.id === value.moduleId))) {
    return NextResponse.json({ error: "moduleId must be a supported gateway module." }, { status: 400 });
  }
  if (value.providerId !== undefined && (typeof value.providerId !== "string" || !/^[a-z0-9._-]{1,60}$/.test(value.providerId))) {
    return NextResponse.json({ error: "providerId is invalid." }, { status: 400 });
  }
  if (value.temperature !== undefined && (typeof value.temperature !== "number" || value.temperature < 0 || value.temperature > 2)) {
    return NextResponse.json({ error: "temperature must be between 0 and 2." }, { status: 400 });
  }
  if (value.max_tokens !== undefined && (!Number.isInteger(value.max_tokens) || Number(value.max_tokens) < 1 || Number(value.max_tokens) > 16384)) {
    return NextResponse.json({ error: "max_tokens must be an integer between 1 and 16384." }, { status: 400 });
  }
  const requestId = randomUUID();
  try {
    const result = await chatCompletionWithFallback({
      requestId,
      model: value.model,
      messages,
      ...(typeof value.moduleId === "string" ? { moduleId: value.moduleId } : {}),
      ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(typeof value.max_tokens === "number" ? { max_tokens: value.max_tokens } : {}),
      signal: request.signal
    });
    // Operational telemetry only: never log prompt text, response content, or credentials.
    console.info("[model-gateway]", JSON.stringify({
      event: "completion", provider: result.provider, model: result.model,
      latencyMs: result.latencyMs, usage: result.usage ?? null, at: new Date().toISOString()
    }));
    return NextResponse.json({ ...result, requestId }, { headers: {
      "Cache-Control": "no-store",
      "X-RateLimit-Limit": String(limit.limit),
      "X-RateLimit-Remaining": String(limit.remaining)
    } });
  } catch (error) {
    const status = error instanceof GatewayError ? error.status : (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502);
    const message = error instanceof Error ? error.message : "Model gateway request failed.";
    // Never send credentials or arbitrary provider response bodies to the client.
    return NextResponse.json({ error: message, requestId, provider: error instanceof GatewayError ? error.provider : undefined },
      { status: status >= 400 && status <= 599 ? status : 502, headers: { "Cache-Control": "no-store" } });
  }
}
