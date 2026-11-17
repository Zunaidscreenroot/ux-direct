import { NextResponse } from "next/server";
import { retrieveBrainContext, saveBrainFeedback } from "@/src/memory/shared-brain";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A11y Studio's door to the shared brain, locked to its own branch.
 *
 * The brain holds UX Direct's global scope too, and handing that to an accessibility audit
 * would pull in design-agent context that has nothing to do with the question — slower, and
 * worse answers. So this door never reads or writes UX_SHARED_BRAIN: it works on
 * "project:ux-audit" and, when asked, one client sub-branch under it. The curated UX
 * knowledge pack is switched off here for the same reason; Studio brings its own
 * accessibility knowledge base.
 *
 *   POST { action: "recall", query, client?, limit? }
 *     -> { context, scopes, memories }
 *   POST { action: "learn", title, rule, evidence, client?, provenance, kind?, ... }
 *     -> { stored, id, status, relevance }   or 422 with the relevance score
 *
 * Writes land with status "draft" and are only used once a person approves them, which is
 * what keeps a wrong finding from teaching the next audit. Relevance is the brain's own
 * 50% gate; below it nothing is stored and the score comes back so the caller can say why.
 */
const BRANCH = "project:ux-audit";
const CLIENT = /^[a-z0-9][a-z0-9-]{1,40}$/;
const PROVENANCE = new Set(["measured", "model", "human"]);

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
/** The branch, plus one client sub-branch when named. Never the global scope. */
function scopesFor(client: unknown): string[] {
  const slug = typeof client === "string" ? client.trim().toLowerCase() : "";
  return slug && CLIENT.test(slug) ? [BRANCH, "project:" + slug] : [BRANCH];
}
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new Response(null, { status: originOk(origin) ? 204 : 403, headers: cors(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  return NextResponse.json({ ok: true, gateway: "a11y-brain", branch: BRANCH, threshold: 0.5, writeStatus: "draft" }, { headers: cors(origin) });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = cors(origin);
  if (!originOk(origin)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkGatewayRateLimit("a11y-brain:" + ip, Date.now(), 60);
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429, headers: { ...headers, "Retry-After": String(limit.retryAfterSeconds) } });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Body must be JSON." }, { status: 400, headers });
  const action = text(body.action, 20);
  const scopes = scopesFor(body.client);

  if (action === "recall") {
    const query = text(body.query, 4000);
    if (!query) return NextResponse.json({ error: "query is required." }, { status: 400, headers });
    const want = Math.max(1, Math.min(10, Number(body.limit) || 6));
    try {
      const found = await retrieveBrainContext({
        query, scopeKeys: scopes, limit: want,
        // Studio carries its own accessibility knowledge, and UX Direct's identity entries
        // are noise in an audit, so only this branch's memories come back.
        uxKnowledgeShare: 0, skipIdentity: true,
      });
      return NextResponse.json({
        ok: true, scopes,
        context: found.contextText || "",
        memories: found.retrieval.memoryCount,
        knowledge: found.retrieval.knowledgeChunkCount,
        status: found.retrieval.status,
      }, { headers });
    } catch (e) {
      return NextResponse.json({ error: "Could not read the brain: " + (e instanceof Error ? e.message.slice(0, 180) : "unknown") }, { status: 502, headers });
    }
  }

  if (action === "learn") {
    const title = text(body.title, 180);
    const rule = text(body.rule, 2400);
    const evidence = text(body.evidence, 8000) || rule;
    const provenance = text(body.provenance, 20) || "model";
    if (!title || !rule) return NextResponse.json({ error: "title and rule are required." }, { status: 400, headers });
    if (!PROVENANCE.has(provenance)) return NextResponse.json({ error: "provenance must be measured, model or human." }, { status: 400, headers });
    try {
      const saved = await saveBrainFeedback({
        title, normalizedRule: rule, rawFeedback: evidence,
        rationale: text(body.rationale, 1800),
        scopeKey: scopes[scopes.length - 1],      // the client sub-branch when given, else the branch
        sourceProduct: "ux-audit",
        feedbackKind: text(body.kind, 48) || "accessibility",
        keywords: Array.isArray(body.keywords) ? (body.keywords as unknown[]).map((k) => text(k, 40)).filter(Boolean).slice(0, 12) : undefined,
        sourceAuditRef: text(body.auditRef, 180),
        sourceFindingTitle: text(body.findingTitle, 180),
        // Provenance is what lets a reviewer tell a measured fact from a sentence a model
        // wrote. Without it every draft looks equally trustworthy a month later.
        metadata: { provenance, branch: BRANCH, screens: Number(body.screens) || undefined, product: "a11y-studio" },
      });
      return NextResponse.json({ ok: true, stored: true, id: saved.id, duplicate: saved.duplicate, status: saved.status || "draft", scope: scopes[scopes.length - 1], provenance }, { headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      // The brain's own 50% relevance gate. Not an error: the candidate was simply too thin.
      if (/relevance scored/i.test(msg)) {
        const pct = Number((msg.match(/(\d+)%/) || [])[1]);
        return NextResponse.json({ ok: true, stored: false, reason: "below-threshold", relevance: Number.isFinite(pct) ? pct / 100 : null, threshold: 0.5, message: msg.slice(0, 300) }, { status: 422, headers });
      }
      return NextResponse.json({ error: "Could not write to the brain: " + msg.slice(0, 180) }, { status: 502, headers });
    }
  }

  return NextResponse.json({ error: 'action must be "recall" or "learn".' }, { status: 400, headers });
}
