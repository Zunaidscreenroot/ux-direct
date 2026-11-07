import { NextResponse } from "next/server";
import { z } from "zod";
import { runStructuralLint, summarizeStructuralLint } from "@/src/figma-agent/structural-lint";
import { SCREEN_STATES, stateDroppableTexts } from "@/src/figma-agent/screen-states";

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

/** Model-free structural lint: overlap, clipping, collapsed text and source-content preservation. */
export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.object({
    prompt: z.string().trim().min(1).max(5000),
    sourceCanvas: z.unknown().optional(),
    outputCanvas: z.unknown(),
    sourceRootId: z.string().max(100).optional(),
    outputRootId: z.string().max(100).optional(),
    /** States pack: the texts an empty/loading state drops on purpose are not "missing". */
    state: z.enum(SCREEN_STATES).optional(),
    /** Accepted so the plugin can send the same body everywhere; lint thresholds are the plugin's. */
    designRules: z.string().max(4000).optional(),
  }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Lint input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  if (JSON.stringify(parsed.data.outputCanvas ?? null).length > 400_000 || JSON.stringify(parsed.data.sourceCanvas ?? null).length > 400_000) {
    return NextResponse.json({ error: "Canvas evidence is too large to lint." }, { status: 413, headers });
  }
  const { state, ...lintInput } = parsed.data;
  const result = runStructuralLint({ ...lintInput, ignoreTexts: stateDroppableTexts(lintInput.sourceCanvas, state ?? null) });
  return NextResponse.json({ ok: true, ...result, summary: summarizeStructuralLint(result) }, { headers });
}
