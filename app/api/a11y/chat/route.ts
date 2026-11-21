import { NextResponse } from "next/server";
import { gatewayChatCompletion, gatewayEnv } from "@/src/llm-gateway/router";
import { anthropicLiveCompletion, isLiveSeat, LIVE_SEATS, LiveError, openAIShape } from "@/src/llm-gateway/anthropic-live";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A11y gateway: the entry point A11y Studio (accessaudit-sigma.vercel.app) and its Figma plugin use
 * to reach UX Direct's own free-model gateway (src/llm-gateway). Same providers and keys, separate door:
 * - one of four seats (accessibility by default; researcher, lead or content-writer for long reviews and reports);
 * - text, plus up to two screens as data URLs on the user message, small token caps, per-IP rate limit;
 *   the router already routes a request carrying images to a vision-capable model, so A11y Studio's
 *   screen scan needs no key of its own. Only data: URLs are accepted, so this door cannot be used
 *   to make the gateway fetch an arbitrary address;
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
    "Access-Control-Expose-Headers": "x-uxd-provider, x-uxd-anthropic",
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
  return NextResponse.json({ ok: true, gateway: "a11y", seats: ["accessibility", "researcher", "lead", "content-writer", ...LIVE_SEATS], vision: true, maxImages: 2 }, { headers: cors(origin) });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = cors(origin);
  if (!originOk(origin)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("a11y:" + ip, Date.now(), 40);
  if (!limit.allowed) return NextResponse.json({ error: "Too many AI requests. Try again in a minute." }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retryAfterSeconds) } });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const messages = Array.isArray(body?.messages) ? body!.messages as Array<Record<string, unknown>> : null;
  if (!messages || messages.length < 1 || messages.length > 12) return NextResponse.json({ error: "messages must hold 1 to 12 entries." }, { status: 400, headers });
  type Part = { type: "text"; text: string; cache?: boolean } | { type: "image_url"; image_url: { url: string }; cache?: boolean };
  const clean: Array<{ role: string; content: string | Part[] }> = [];
  let total = 0;      // text only: a screen is far bigger than any prompt and is capped on its own
  let images = 0;
  const MAX_IMAGES = 2;
  const MAX_IMAGE_CHARS = 1_600_000;   // about 1.2 MB of PNG once decoded
  for (const m of messages) {
    const role = String(m?.role || "");
    if (!["system", "user", "assistant"].includes(role)) return NextResponse.json({ error: "Unknown message role." }, { status: 400, headers });
    if (typeof m?.content === "string") { total += m.content.length; clean.push({ role, content: m.content }); continue; }
    // A screen may ride along, but only on the user message and only as a data URL.
    if (!Array.isArray(m?.content)) return NextResponse.json({ error: "content must be text, or an array of text and image parts." }, { status: 400, headers });
    if (role !== "user") return NextResponse.json({ error: "Only the user message may carry an image." }, { status: 400, headers });
    const parts: Part[] = [];
    for (const raw of m.content as Array<Record<string, unknown>>) {
      const kind = String((raw as { type?: unknown })?.type || "");
      if (kind === "text") {
        const t = typeof raw.text === "string" ? raw.text : "";
        total += t.length; parts.push({ type: "text", text: t, ...(raw.cache === true ? { cache: true } : {}) }); continue;
      }
      if (kind === "image_url") {
        const url = String((raw.image_url as { url?: unknown } | undefined)?.url || "");
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(url)) return NextResponse.json({ error: "An image must be a data URL (png, jpeg or webp)." }, { status: 400, headers });
        if (url.length > MAX_IMAGE_CHARS) return NextResponse.json({ error: "Screen image too large: render it narrower (about 420 px wide)." }, { status: 413, headers });
        if (++images > MAX_IMAGES) return NextResponse.json({ error: "At most " + MAX_IMAGES + " images per request." }, { status: 400, headers });
        parts.push({ type: "image_url", image_url: { url }, ...(raw.cache === true ? { cache: true } : {}) }); continue;
      }
      return NextResponse.json({ error: "Unknown content part: " + kind }, { status: 400, headers });
    }
    if (!parts.length) return NextResponse.json({ error: "content must hold at least one part." }, { status: 400, headers });
    clean.push({ role, content: parts });
  }
  const live = isLiveSeat(String(body?.seat || ""));
  // Live audit's module review sends the findings of a whole module, so its seats get more room.
  if (total > (live ? 60_000 : 24_000)) return NextResponse.json({ error: "Request too large." }, { status: 413, headers });
  // The ceiling was 1400, which was fine while every caller was a short text task. A request
  // carrying a screen is routed to a reasoning model, and its thinking tokens come out of the
  // same budget: at 1400 the answer was cut off after a line or two and the caller got
  // unparseable JSON. A request with an image gets room for the thinking and the reply.
  const ceiling = live ? 4000 : images > 0 ? 4000 : 1400;
  const maxTokens = Math.max(64, Math.min(ceiling, Number(body?.max_tokens) || 500));
  // Seat: short answers go to the fast accessibility seat; long reviews and reports may ask for the stronger seats.
  // The director seat is the strongest judgement available, kept for the one output a client
  // reads first: the executive summary of an audit.
  const SEATS = ["accessibility", "researcher", "lead", "content-writer", "director", ...LIVE_SEATS] as const;
  const seat = SEATS.includes(String(body?.seat) as (typeof SEATS)[number]) ? String(body?.seat) : "accessibility";

  // Live audit: Anthropic first, on one fixed model per seat; the free gateway is the fallback.
  let anthropicError: LiveError | null = null;
  if (isLiveSeat(seat)) {
    try {
      const schema = body?.schema && typeof body.schema === "object" && !Array.isArray(body.schema) ? body.schema as Record<string, unknown> : null;
      const result = await anthropicLiveCompletion({ seat, messages: clean, maxTokens: Number(body?.max_tokens) || 1500, schema, env: gatewayEnv(), signal: request.signal });
      return NextResponse.json(openAIShape(result), { headers: { ...headers, "x-uxd-provider": "anthropic" } });
    } catch (error) {
      anthropicError = error instanceof LiveError ? error : new LiveError("busy", "Anthropic failed.");
      // Anthropic only, for now: the free fallback runs only when UXD_LIVE_FALLBACK=on.
      const code = anthropicError.code === "no_key" ? "used_up" : anthropicError.code === "refused" ? "bad_request" : anthropicError.code;
      if (anthropicError.code === "bad_request" || gatewayEnv().UXD_LIVE_FALLBACK !== "on") {
        const status = code === "busy" ? (anthropicError.status === 429 ? 429 : 503) : code === "used_up" ? 503 : 400;
        return NextResponse.json({ error: { message: anthropicError.message, code } }, { status, headers: { ...headers, "x-uxd-provider": "anthropic" } });
      }
      console.warn("[a11y-live] anthropic fell back:", anthropicError.code);
    }
  }

  const upstreamHeaders = new Headers({ "content-type": "application/json", "x-uxd-agent-role": seat });
  // A screen needs describing, not pondering. Left to think, the model spends the whole output
  // budget on deliberation and the JSON comes back cut off after a line or two.
  const plain = clean.map((m) => (typeof m.content === "string" ? m : { role: m.role, content: m.content.map((part) => { const rest = { ...part }; delete rest.cache; return rest; }) }));
  const payload: Record<string, unknown> = { model: "auto", messages: plain, max_tokens: maxTokens, temperature: 0.2, response_format: { type: "json_object" } };
  if (images > 0) payload.reasoning_effort = "none";
  const upstream = await gatewayChatCompletion(JSON.stringify(payload), upstreamHeaders, request.signal);
  const text = await upstream.text();
  if (isLiveSeat(seat) && !upstream.ok) {
    // Tell Live audit plainly what to do: retry when busy, switch path when used up.
    const code = upstream.status === 429 || upstream.status >= 500 && !/balance|quota|exhaust|insufficient/i.test(text) ? "busy" : "used_up";
    return NextResponse.json({ error: { message: (code === "busy" ? "AI is busy; retry shortly." : "AI quota is used up.") + (anthropicError ? " Anthropic: " + anthropicError.code + "." : ""), code } },
      { status: upstream.status === 429 ? 429 : 503, headers: { ...headers, "x-uxd-provider": "gateway" } });
  }
  return new Response(text, { status: upstream.status, headers: { ...headers, "content-type": "application/json", ...(isLiveSeat(seat) ? { "x-uxd-provider": "gateway", "x-uxd-anthropic": anthropicError?.code || "" } : {}) } });
}
