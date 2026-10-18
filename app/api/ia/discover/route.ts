import { NextResponse } from "next/server";
import { discoverSiteMap } from "@/src/ia/site-crawler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestCounts = new Map<string, { count: number; windowStart: number }>();
function allowRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const key = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const state = requestCounts.get(key);
  if (!state || now - state.windowStart > 10 * 60_000) {
    requestCounts.set(key, { count: 1, windowStart: now });
    return true;
  }
  state.count += 1;
  return state.count <= 8;
}

export async function POST(request: Request) {
  if (!allowRequest(request)) {
    return NextResponse.json({ error: "IA discovery is rate limited or this origin is not allowed." }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.url !== "string" || input.url.length > 2048) {
    return NextResponse.json({ error: "A website URL is required." }, { status: 400 });
  }
  try {
    const result = await discoverSiteMap(input.url, {
      maxPages: typeof input.maxPages === "number" ? input.maxPages : 120,
      maxDepth: typeof input.maxDepth === "number" ? input.maxDepth : 3,
      budgetMs: 18_000
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "IA discovery failed." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
