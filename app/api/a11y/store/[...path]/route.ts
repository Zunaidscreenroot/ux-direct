import { NextResponse } from "next/server";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";
import { listR2Keys, readR2Json, writeR2Json } from "@/src/storage/r2-json-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A11y Studio workspace store (projects, audits, prototype uploads), shared by the Studio web app and,
 * later, the A11y Studio Figma plugin.
 *
 * Storage: the existing UX_SHARED_ASSETS R2 bucket, under its own prefix `a11y-studio/<workspace>/`.
 * Access: capability tokens. A workspace is created by its first write; the server keeps only a SHA-256
 * hash of its token. Every request must send `x-a11y-workspace` and `Authorization: Bearer <token>`.
 *
 *   GET    /api/a11y/store/index              list of stored objects
 *   GET    /api/a11y/store/{kind}/{id}        one object (kind: project | audit | upload | settings)
 *   PUT    /api/a11y/store/{kind}/{id}        create or replace (JSON body, up to 4 MB)
 */
const ALLOWED = [/^https:\/\/accessaudit[a-z0-9-]*\.vercel\.app$/, /^https?:\/\/localhost(:\d+)?$/, /^https:\/\/(www\.)?figma\.com$/];
const KINDS = new Set(["project", "audit", "upload", "settings"]);
const ID = /^[a-z0-9][a-z0-9_-]{2,63}$/i;
const MAX = 4_000_000;

function originOk(origin: string | null) { return !origin || origin === "null" || ALLOWED.some((re) => re.test(origin)); }
function cors(origin: string | null): HeadersInit {
  return { ...(origin && originOk(origin) ? { "Access-Control-Allow-Origin": origin } : {}), "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-a11y-workspace", "Cache-Control": "no-store", Vary: "Origin" };
}
async function sha(text: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
type Meta = { hash: string; created: number };

async function auth(request: Request, create: boolean): Promise<{ ws: string } | { error: string; status: number }> {
  const ws = request.headers.get("x-a11y-workspace") || ""; const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!ID.test(ws) || token.length < 32 || token.length > 128) return { error: "Workspace id and token are required.", status: 401 };
  const metaKey = `a11y-studio/${ws}/_meta.json`; const meta = await readR2Json<Meta>(metaKey); const hash = await sha(token);
  if (!meta) { if (!create) return { error: "Unknown workspace.", status: 404 }; await writeR2Json(metaKey, { hash, created: Date.now() }); return { ws }; }
  return meta.hash === hash ? { ws } : { error: "Wrong workspace token.", status: 403 };
}

export async function OPTIONS(request: Request) { const origin = request.headers.get("origin"); return new Response(null, { status: originOk(origin) ? 204 : 403, headers: cors(origin) }); }

async function handle(request: Request, path: string[], method: "GET" | "PUT") {
  const origin = request.headers.get("origin"); const headers = cors(origin);
  if (!originOk(origin)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!checkGatewayRateLimit("a11y-store:" + ip, Date.now(), 120).allowed) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers });
  const a = await auth(request, method === "PUT"); if ("error" in a) return NextResponse.json({ error: a.error }, { status: a.status, headers });
  const prefix = `a11y-studio/${a.ws}/`;
  if (method === "GET" && path.length === 1 && path[0] === "index") {
    const keys = (await listR2Keys(prefix, 2000)).filter((k) => !k.endsWith("_meta.json")).map((k) => k.slice(prefix.length).replace(/\.json$/, ""));
    return NextResponse.json({ ok: true, objects: keys }, { headers });
  }
  const [kind, id] = path; if (path.length !== 2 || !KINDS.has(kind) || !ID.test(id)) return NextResponse.json({ error: "Use /{project|audit|upload|settings}/{id}." }, { status: 400, headers });
  const key = `${prefix}${kind}/${id}.json`;
  if (method === "GET") { const v = await readR2Json<unknown>(key); return v === null ? NextResponse.json({ error: "Not found." }, { status: 404, headers }) : NextResponse.json({ ok: true, value: v }, { headers }); }
  const text = await request.text(); if (text.length > MAX) return NextResponse.json({ error: "Too large (4 MB max)." }, { status: 413, headers });
  let value: unknown; try { value = JSON.parse(text); } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400, headers }); }
  await writeR2Json(key, { savedAt: Date.now(), value });
  return NextResponse.json({ ok: true, key: `${kind}/${id}` }, { headers });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) { return handle(request, (await ctx.params).path, "GET"); }
export async function PUT(request: Request, ctx: { params: Promise<{ path: string[] }> }) { return handle(request, (await ctx.params).path, "PUT"); }
