import { NextResponse } from "next/server";
import { z } from "zod";
import { getOperationalEvents, recordOperationalEvent } from "@/src/observability/event-log";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function isAllowedOrigin(origin: string | null, request: Request): boolean {
  return !origin || origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://www.figma.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}
const eventSchema = z.object({
  source: z.enum(["dashboard", "figma-plugin", "backend"]),
  event: z.string().trim().min(1).max(80),
  status: z.enum(["success", "warning", "error", "info"]),
  summary: z.string().trim().min(1).max(240),
  requestId: z.string().max(80).optional(),
  project: z.string().max(80).optional(),
  durationMs: z.number().nonnegative().max(600000).optional(),
  mode: z.string().max(40).optional(),
  category: z.string().max(80).optional(),
  action: z.string().max(120).optional(),
  testType: z.enum(["availability", "functional", "not-tested"]).optional()
});
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}
export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, request)) return NextResponse.json({ error: "Origin not allowed" }, { status: 403, headers: corsHeaders(origin) });
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || "30");
  return NextResponse.json({
    events: getOperationalEvents(Number.isFinite(limit) ? limit : 30),
    retention: "best_effort_runtime",
    note: "Recent events are held in server memory and may reset when serverless instances restart. Structured events are also written to Vercel runtime logs."
  }, { headers: corsHeaders(origin) });
}
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, request)) return NextResponse.json({ error: "Origin not allowed" }, { status: 403, headers: corsHeaders(origin) });
  let body: unknown;
  try {
    const raw = await request.text();
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400, headers: corsHeaders(origin) });
  }
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid telemetry event" }, { status: 400, headers: corsHeaders(origin) });
  const event = recordOperationalEvent(parsed.data);
  return NextResponse.json({ accepted: true, eventId: event.id }, { status: 202, headers: corsHeaders(origin) });
}
