import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { providersFromEnv } from "@/src/model-gateway";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function isAllowedOrigin(origin: string | null, request: Request): boolean {
  return !origin || origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://www.figma.com",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}
export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, request)) return NextResponse.json({ status: "blocked", error: "Origin not allowed" }, { status: 403, headers: corsHeaders(origin) });
  if (origin && ["null", "https://www.figma.com", "https://figma.com"].includes(origin)) {
    const fileKey = new URL(request.url).searchParams.get("fileKey");
    if (!isAllowedFigmaFileKey(fileKey)) return NextResponse.json({ status: "blocked", error: "Approved Figma file key required." }, { status: 403, headers: corsHeaders(origin) });
  }
  const figmaOAuthConfigured = Boolean(process.env.FIGMA_CLIENT_ID && process.env.FIGMA_CLIENT_SECRET && process.env.FIGMA_REDIRECT_URI);
  const activeProviders = providersFromEnv().filter(provider => provider.kind !== "mock");
  return NextResponse.json({
    service: "ux-direct-backend", status: "ok", checkedAt: new Date().toISOString(),
    deployment: { platform: "cloudflare", host: new URL(request.url).host },
    mode: activeProviders.length ? activeProviders.map(provider => provider.name).join(", ") : "mock",
    modelProviderConfigured: activeProviders.length > 0,
    figma: {
      oauthConfigured: figmaOAuthConfigured,
      status: figmaOAuthConfigured ? "configured_not_verified" : "not_configured",
      note: figmaOAuthConfigured ? "OAuth credentials are present; user authorization has not been verified by this endpoint." : "Figma account login is not configured yet. Plugin-to-backend reachability is checked separately."
    },
    capabilities: { taskPlanning: true, figmaRead: false, figmaWrite: false, operationalLog: "best_effort_runtime" }
  }, { headers: corsHeaders(origin) });
}
