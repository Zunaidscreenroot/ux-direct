import { NextResponse } from "next/server";
import { z } from "zod";
import { recordOperationalEvent } from "@/src/observability/event-log";
import { FIGMA_PROVIDER_OPTIONS, isFigmaProviderConfigured, saveFigmaProvider, selectFigmaProvider } from "@/src/providers/figma-llm";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIGMA_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function cors(origin: string | null): Record<string, string> {
  return {
    ...(origin && FIGMA_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}
function allowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || FIGMA_ORIGINS.has(origin);
}
export async function OPTIONS(request: Request) {
  return new Response(null, { status: allowed(request) ? 204 : 403, headers: cors(request.headers.get("origin")) });
}
export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (!allowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(origin) });
  return NextResponse.json({ selected: await selectFigmaProvider(), options: FIGMA_PROVIDER_OPTIONS }, { headers: cors(origin) });
}

const schema = z.object({ provider: z.enum(["openrouter", "freellmapi"]), fileKey: z.string().max(200).optional() }).strict();
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!allowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(origin) });
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "provider must be openrouter or freellmapi." }, { status: 400, headers: cors(origin) });
  const isFigma = origin !== null && FIGMA_ORIGINS.has(origin);
  if (isFigma && !isAllowedFigmaFileKey(body.data.fileKey)) return NextResponse.json({ error: "Approved Figma file key required." }, { status: 403, headers: cors(origin) });
  if (!isFigmaProviderConfigured(body.data.provider)) {
    return NextResponse.json({ error: "That provider is not configured on the Worker yet.", configured: false }, { status: 409, headers: cors(origin) });
  }
  const saved = await saveFigmaProvider(body.data.provider);
  recordOperationalEvent({
    source: isFigma ? "figma-plugin" : "dashboard", event: "Model provider switched", status: saved ? "success" : "warning",
    category: "model", action: body.data.provider,
    summary: saved ? "Provider set to " + body.data.provider + "." : "Provider applied for this session only; persistent storage was unavailable.",
  });
  return NextResponse.json({ selected: body.data.provider, saved }, { headers: cors(origin) });
}
