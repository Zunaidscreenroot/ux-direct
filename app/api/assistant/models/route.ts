import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function headers(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return {
    ...(origin && (origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin)) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function capability(id: string, raw: Record<string, unknown>) {
  const text = id.toLowerCase();
  const metadata = JSON.stringify(raw).toLowerCase();
  const vision = /vision|visual|multimodal|image|vl-|4v|llava|pixtral|gemini|gpt-4o|glm.*v|4\.6v|4\.5v/.test(text) ||
    /vision|image input|multimodal/.test(metadata);
  const reasoning = /reason|thinking|deepseek-r1|glm|kimi|qwen3|qwq|o1|o3|o4|nemotron|deepseek-v/.test(text) ||
    /reasoning|thinking/.test(metadata);
  const tools = /tool.call|function.call|tool_calling|supports_tools|tools.*true/.test(metadata);
  const context = Number(raw.context_length ?? raw.context_window ?? raw.contextLength ?? 0);
  return { vision, reasoning, tools, contextWindow: Number.isFinite(context) && context > 0 ? context : null };
}
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: headers(request) });
}
export async function GET(request: Request) {
  const responseHeaders = headers(request);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: responseHeaders });
  }
  const key = process.env.FREELLMAPI_API_KEY?.trim();
  const base = (process.env.FREELLMAPI_BASE_URL?.trim() || "http://127.0.0.1:3001/v1").replace(/\/+$/, "");
  if (!key) return NextResponse.json({ provider: "FreeLLMAPI", connected: false, models: [], error: "FreeLLMAPI API key is not configured on the server." }, { status: 503, headers: responseHeaders });
  try {
    const response = await fetch(base + "/models", {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return NextResponse.json({ provider: "FreeLLMAPI", connected: false, models: [], error: "FreeLLMAPI model catalog returned HTTP " + response.status + "." }, { status: 502, headers: responseHeaders });
    const payload = await response.json() as { data?: unknown[]; models?: unknown[] };
    const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const models = items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
      if (!id || id.length > 200) return [];
      const caps = capability(id, raw);
      return [{ id, name: typeof raw.name === "string" ? raw.name : id, ...caps }];
    }).sort((a, b) => a.id.localeCompare(b.id));
    return NextResponse.json({ provider: "FreeLLMAPI", connected: true, baseUrl: base, models, checkedAt: new Date().toISOString() }, { headers: responseHeaders });
  } catch (error) {
    return NextResponse.json({
      provider: "FreeLLMAPI", connected: false, models: [],
      error: error instanceof Error ? error.message : "Could not reach FreeLLMAPI.",
    }, { status: 502, headers: responseHeaders });
  }
}
