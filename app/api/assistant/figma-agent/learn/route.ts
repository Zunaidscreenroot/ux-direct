import { NextResponse } from "next/server";
import { z } from "zod";
import { buildDesignerLesson } from "@/src/memory/designer-feedback";
import { saveBrainFeedback } from "@/src/memory/shared-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}
function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const permitted = origin && (origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin));
  return {
    ...(permitted ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

export async function OPTIONS(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}

/** Automatic learning: designer critique and explanations from the plugin become shared-brain lessons. */
export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const parsed = z.object({
    kind: z.enum(["critique", "explanation", "rule"]),
    text: z.string().trim().min(3).max(1200),
    request: z.string().max(5000).optional(),
  }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Learning input is invalid." }, { status: 400, headers });
  const lesson = buildDesignerLesson(parsed.data.kind, parsed.data.text, parsed.data.request || "");
  if (!lesson) return NextResponse.json({ ok: false, error: "Nothing reusable to save (empty or private details)." }, { status: 422, headers });
  try {
    const saved = await saveBrainFeedback({ ...lesson, sourceProduct: "figma-plugin", scopeKey: "UX_SHARED_BRAIN" });
    return NextResponse.json({ ok: true, id: saved.id, duplicate: saved.duplicate, title: lesson.title }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "Saving the lesson failed." }, { status: 502, headers });
  }
}
