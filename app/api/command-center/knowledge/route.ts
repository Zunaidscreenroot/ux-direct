import { NextResponse } from "next/server";
import { z } from "zod";
import { commandCenterLockedResponse, isCommandCenterAuthorized, knowledgeEditState } from "@/src/command-center/access";
import { loadSharedKnowledge } from "@/src/command-center/knowledge";
import { CORE_KNOWLEDGE_VERSION } from "@/src/knowledge/corpus";
import { rankKnowledge, packKnowledge } from "@/src/knowledge/retrieve";
import { listKnowledgeForPage, loadKnowledgeEntries, removeKnowledgeEntry, restoreCoreEntry, saveKnowledgeEntry } from "@/src/knowledge/store";
import { CATEGORY_LABELS, KNOWLEDGE_DOMAINS, KNOWLEDGE_ROLES, type KnowledgeCategory } from "@/src/knowledge/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

/**
 * Knowledge base for the command center.
 * GET            → every entry (core + owner), hidden core entries, legacy brain rules/docs, edit state.
 * GET ?q=…       → retrieval preview: what a role would be given for that task.
 * POST           → save | remove | restore (edit-gated, see knowledgeEditState).
 */
export async function GET(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  if (!isCommandCenterAuthorized(request)) return commandCenterLockedResponse();
  const url = new URL(request.url);
  try {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 2000);
    if (q) {
      const entries = await loadKnowledgeEntries();
      const ranked = rankKnowledge(entries, { query: q, role: url.searchParams.get("role"), domain: url.searchParams.get("domain"), limit: 10 });
      const pack = packKnowledge(ranked, 6000);
      return NextResponse.json({
        results: ranked.map(({ entry, score }) => ({ id: entry.id, title: entry.title, category: entry.category, score: Number.isFinite(score) ? Math.round(score * 100) / 100 : "pinned" })),
        packedIds: pack.ids, packedChars: pack.chars, preview: pack.text,
      }, { headers });
    }
    const [page, legacy] = await Promise.all([
      listKnowledgeForPage(),
      loadSharedKnowledge(60).catch(() => ({ rules: [], documents: [] })),
    ]);
    return NextResponse.json({
      ...page,
      legacy,
      version: CORE_KNOWLEDGE_VERSION,
      categories: CATEGORY_LABELS,
      roles: KNOWLEDGE_ROLES,
      domains: KNOWLEDGE_DOMAINS,
      edit: knowledgeEditState(request),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 200) : "Knowledge base is unavailable." }, { status: 503, headers });
  }
}

const categories = Object.keys(CATEGORY_LABELS) as [KnowledgeCategory, ...KnowledgeCategory[]];
const entrySchema = z.object({
  id: z.string().trim().max(80).optional(),
  title: z.string().trim().min(3).max(200),
  category: z.enum(categories),
  roles: z.array(z.enum(["all", ...KNOWLEDGE_ROLES] as [string, ...string[]])).min(1).max(14),
  domains: z.array(z.enum(KNOWLEDGE_DOMAINS as [string, ...string[]])).max(11).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(24),
  body: z.string().trim().min(20).max(4000),
  sources: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
}).strict();
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), entry: entrySchema }).strict(),
  z.object({ action: z.literal("remove"), id: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("restore"), id: z.string().trim().min(1).max(80) }).strict(),
]);

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const edit = knowledgeEditState(request);
  if (!edit.allowed) return NextResponse.json({ error: edit.reason, editLocked: true }, { status: 403, headers });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid knowledge entry." }, { status: 400, headers });
  try {
    const input = parsed.data;
    if (input.action === "save") {
      const entry = { ...input.entry, roles: input.entry.roles as never, domains: input.entry.domains as never };
      return NextResponse.json(await saveKnowledgeEntry(entry), { headers });
    }
    if (input.action === "remove") await removeKnowledgeEntry(input.id);
    else await restoreCoreEntry(input.id);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 200) : "Could not save." }, { status: 500, headers });
  }
}
