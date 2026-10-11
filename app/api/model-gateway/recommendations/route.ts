import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";
import { getCapabilityRecommendations } from "@/src/model-gateway/openrouter-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.MODEL_GATEWAY_ACCESS_KEY;
  if (!expected) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    request.headers.get("x-model-gateway-key");
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const sameOriginBrowser = Boolean(origin && origin === new URL(request.url).origin &&
    request.headers.get("sec-fetch-site") !== "cross-site");
  // The planner uses a zero-price :free model and sends only public capability
  // metadata. Same-origin dashboard calls may run without a client-held secret;
  // direct API callers still need the access key, and the route is rate limited.
  if (!authorized(request) && !sameOriginBrowser) return NextResponse.json({ error: "Use the gateway dashboard or provide the gateway access key." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const ip = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("model-recommendations:" + ip, Date.now(), 5);
  if (!limit.allowed) return NextResponse.json({ error: "Planner rate limit reached. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" } });
  try {
    const recommendations = await getCapabilityRecommendations(new URL(request.url).searchParams.get("refresh") === "true");
    return NextResponse.json(recommendations, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Model recommendations could not be generated." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
