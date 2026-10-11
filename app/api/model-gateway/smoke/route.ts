import { NextResponse } from "next/server";
import { chatCompletion, type ProviderConfig } from "@/src/model-gateway";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This endpoint can only execute the deterministic mock: it never reads provider keys
// or makes outbound network calls, so the dashboard can be tested before API setup.
export async function POST(request: Request) {
  const ip = request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("smoke:" + ip);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Smoke-test rate limit exceeded." }, {
      status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "no-store" }
    });
  }
  const mockProvider: ProviderConfig = {
    name: "mock", baseUrl: "mock://local", models: ["mock/ux-direct"], kind: "mock"
  };
  const requestId = crypto.randomUUID();
  const result = await chatCompletion({
    requestId,
    model: "mock/ux-direct",
    messages: [{ role: "user", content: "UX Direct gateway zero-cost smoke test" }]
  }, { providers: [mockProvider] });
  return NextResponse.json({
    ok: result.provider === "mock" && result.usage?.total_tokens === 0,
    requestId, provider: result.provider, model: result.model,
    tokens: result.usage, costInr: 0, latencyMs: result.latencyMs,
    message: "Mock smoke test passed. No provider API or external network call was used."
  }, { headers: { "Cache-Control": "no-store" } });
}
