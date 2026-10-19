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
    deployment: { platform: "cloudflare-workers", host: new URL(request.url).host },
    mode: activeProviders.length ? activeProviders.map(provider => provider.name).join(", ") : "mock",
    modelProviderConfigured: activeProviders.length > 0,
    figma: {
      integration: "native_plugin_api",
      oauthRequired: false,
      oauthConfigured: figmaOAuthConfigured,
      status: "native_plugin_bridge",
      note: "Figma document access uses the installed UX Direct plugin native Figma Plugin APIs. The MCP bridge exposes bounded selection/current-page/name/type-filtered reads, page/style/viewport metadata, and explicitly confirmed canvas writes for node creation/editing, layout/typography/paint/effects, clone/delete/reorder/reparent/group/ungroup/flatten/boolean operations, components/variants/instances, selection/viewport, page create/rename/switch, local styles, image fills, bounded PNG/PDF/SVG export, and sequential batches. Writes stay within the approved Figma file; node IDs resolve on the active page; batches report partial failures. Execution results must be verified by command ID, and the locally imported plugin must include the current bridge command handler. Live plugin reachability is reported separately.",
    },
    capabilities: {
      taskPlanning: true,
      figmaRead: true,
      figmaWrite: true,
      figmaExecution: "scoped_native_plugin_commands",
      operationalLog: "best_effort_runtime"
    }
  }, { headers: corsHeaders(origin) });
}
