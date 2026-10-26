import { NextResponse } from "next/server";
import { collectBackendStatus } from "@/src/backend/status";
import { getChatGPTConnectionStatus, getFigmaPluginConnectionStatus } from "@/src/connections/connection-status";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIGMA_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function cors(origin: string | null): Record<string, string> {
  return {
    ...(origin && FIGMA_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}
export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || !FIGMA_ORIGINS.has(origin)) return NextResponse.json({ error: "Figma plugin origin required." }, { status: 403, headers: cors(origin) });
  return new Response(null, { status: 204, headers: cors(origin) });
}

/** One consolidated read for the plugin's connection panel and the /backend viewer. Never returns secrets. */
export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const isFigma = origin !== null && FIGMA_ORIGINS.has(origin);
  if (origin && !isFigma && origin !== url.origin) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(origin) });
  if (isFigma && !isAllowedFigmaFileKey(url.searchParams.get("fileKey"))) {
    return NextResponse.json({ error: "Approved Figma file key required." }, { status: 403, headers: cors(origin) });
  }
  const clientId = url.searchParams.get("clientId") || undefined;
  if (clientId && (clientId.length < 8 || clientId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(clientId))) {
    return NextResponse.json({ error: "Invalid clientId." }, { status: 400, headers: cors(origin) });
  }
  const status = await collectBackendStatus({
    host: url.host, clientId,
    getPlugin: (id) => getFigmaPluginConnectionStatus(id),
    getChatGpt: async () => {
      const result = await getChatGPTConnectionStatus();
      return { state: result.state, lastActivityAt: result.lastActivityAt };
    },
  });
  return NextResponse.json(status, { headers: cors(origin) });
}
