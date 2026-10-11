import { NextResponse } from "next/server";
import { getModelCatalog, providersFromEnv } from "@/src/model-gateway";

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
  const host = new URL(request.url).hostname;
  return process.env.NODE_ENV !== "production" &&
    process.env.MODEL_GATEWAY_ALLOW_UNAUTHENTICATED_LOCAL === "true" &&
    ["localhost", "127.0.0.1", "::1"].includes(host);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({
      error: process.env.MODEL_GATEWAY_ACCESS_KEY
        ? "Unauthorized model gateway request."
        : "Gateway is locked. Set MODEL_GATEWAY_ACCESS_KEY; unauthenticated access is disabled."
    }, { status: process.env.MODEL_GATEWAY_ACCESS_KEY ? 401 : 503, headers: { "Cache-Control": "no-store" } });
  }
  const providers = providersFromEnv();
  return NextResponse.json({
    gateway: { name: "UX Direct Model Gateway", version: 1, gatewayFee: 0, mode: providers.some(p => p.kind !== "mock") ? "provider-configured" : "mock-only" },
    providers: providers.map(({ name, kind, models, baseUrl }) => ({
      name, kind, models, endpoint: baseUrl.startsWith("mock://") ? "built-in" : baseUrl,
      configured: kind === "mock" || Boolean(baseUrl)
    })),
    models: getModelCatalog(providers),
    checkedAt: new Date().toISOString()
  }, { headers: { "Cache-Control": "no-store" } });
}
