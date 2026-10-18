import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { getFigmaPluginConnectionStatus } from "@/src/connections/connection-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIGMA_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function corsHeaders(origin: string | null): HeadersInit {
  return {
    ...(origin && FIGMA_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function allowedFigmaOrigin(origin: string | null): boolean {
  return origin !== null && FIGMA_ORIGINS.has(origin);
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!allowedFigmaOrigin(origin)) {
    return NextResponse.json({ error: "Figma plugin origin required." }, { status: 403, headers: corsHeaders(origin) });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);
  if (!allowedFigmaOrigin(origin)) {
    return NextResponse.json({ error: "Figma plugin origin required." }, { status: 403, headers });
  }
  const url = new URL(request.url);
  const fileKey = url.searchParams.get("fileKey");
  if (!isAllowedFigmaFileKey(fileKey)) {
    return NextResponse.json({ error: "Approved Figma file key required." }, { status: 403, headers });
  }
  const clientId = url.searchParams.get("clientId");
  if (!clientId || clientId.length < 8 || clientId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(clientId)) {
    return NextResponse.json({ error: "A valid Figma plugin clientId is required." }, { status: 400, headers });
  }
  try {
    const figmaPlugin = await getFigmaPluginConnectionStatus(clientId);
    return NextResponse.json({
      checkedAt: new Date().toISOString(),
      backend: "ok",
      figmaPlugin,
      semantics: {
        figma: "Connected means this approved-file Figma plugin session sent a heartbeat in the last 75 seconds.",
      },
    }, { headers });
  } catch (error) {
    console.error("[ux-direct-connections] Connection status store read failed", error);
    return NextResponse.json({ error: "Could not read connection status from persistent storage." }, { status: 503, headers });
  }
}
