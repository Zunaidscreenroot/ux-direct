import { NextResponse } from "next/server";
import { gatewayChatCompletion } from "@/src/llm-gateway/router";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A11y gateway: the entry point A11y Studio (accessaudit-sigma.vercel.app) and its Figma plugin use
 * to reach UX Direct's own free-model gateway (src/llm-gateway). Same providers and keys, separate door:
 * - only the "accessibility" seat routing is used, whatever the caller sends;
 * - text only (no images), small token caps, per-IP rate limit;
 * - the caller supplies its own system prompt and knowledge (A11y Studio's accessibility knowledge base),
 *   so UX Direct's design persona, brain and learning are not involved.
 */
const ALLOWED = [
  /^https:\/\/accessaudit[a-z0-9-]*\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https:\/\/(www\.)?figma\.com$/,
];
function originOk(origin: string | null): boolean {
  return !origin || origin === "null" || ALLOWED.some((re) => re.test(origin));
}
function cors(origin: string | null): HeadersInit {
  return {
    ...(origin && originOk(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new Response(null, { status: originOk(origin) ? 204 : 403, headers: cors(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  return NextResponse.json({ ok: true, gateway: "a11y", seat: "accessibility" }, { headers: cors(origin) });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = cors(origin);
  if (!originOk(origin)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("a11y:" + ip, Date.now(), 20);
  if (!limit.allowed) return NextResponse.json({ error: "Too many AI requests. Try again in a minute." }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retryAfterSeconds) } });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const messages = Array.isArray(body?.messages) ? body!.messages as Array<Record<string, unknown>> : null;
  if (!messages || messages.length < 1 || messages.length > 12) return NextResponse.json({ error: "messages must hold 1 to 12 entries." }, { status: 400, headers });
  const clean: Array<{ role: string; content: string }> = [];
  let total = 0;
  for (const m of messages) {
    const role = String(m?.role || "");
    if (!["system", "user", "assistant"].includes(role) || typeof m?.content !== "string") return NextResponse.json({ error: "Only text messages are accepted." }, { status: 400, headers });
    total += (m.content as string).length;
    clean.push({ role, content: m.content as string });
  }
  if (total > 24_000) return NextResponse.json({ error: "Request too large." }, { status: 413, headers });
  const maxTokens = Math.max(64, Math.min(900, Number(body?.max_tokens) || 500));

  const upstreamHeaders = new Headers({ "content-type": "application/json", "x-uxd-agent-role": "accessibility" });
  const upstream = await gatewayChatCompletion(JSON.stringify({ model: "auto", messages: clean, max_tokens: maxTokens, temperature: 0.2 }), upstreamHeaders, request.signal);
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { ...headers, "content-type": "application/json" } });
}
