import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { generateBudgetedEmbeddings, resolveKnowledgeProjectKey } from "@/src/figma/knowledge-rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;
const SOURCE_TYPES = new Set(["brief", "figma_reference", "design_decision", "regulation", "research", "design_system", "document", "quality_example"]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function dateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function chunkText(input: string): string[] {
  const text = input.replace(/\r\n?/g, "\n").trim();
  const chunks: string[] = [];
  const maxChars = 3200;
  const overlap = 300;
  let start = 0;
  while (start < text.length && chunks.length < 120) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      const sentence = text.lastIndexOf(". ", end);
      const boundary = Math.max(newline, sentence);
      if (boundary > start + 2100) end = boundary + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    const next = Math.max(start + 1, end - overlap);
    start = next;
  }
  return chunks;
}
function config() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return url && key ? { url, key } : null;
}
function dbHeaders(key: string, prefer?: string): HeadersInit {
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

export async function POST(request: Request) {
  const expected = process.env.UXD_RAG_INGEST_KEY;
  if (!expected) return NextResponse.json({ error: "RAG ingestion is not enabled. Configure UXD_RAG_INGEST_KEY server-side first." }, { status: 503 });
  const provided = request.headers.get("x-uxd-ingest-key") || "";
  if (!provided || !secureEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized RAG ingestion request." }, { status: 401 });
  }

  let payload: unknown;
  try { payload = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!isRecord(payload)) return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });

  const projectKey = typeof payload.projectKey === "string" ? resolveKnowledgeProjectKey(payload.projectKey) : null;
  const title = typeof payload.title === "string" ? payload.title.trim().slice(0, 300) : "";
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl.trim().slice(0, 1500) : null;
  const sourceType = typeof payload.sourceType === "string" && SOURCE_TYPES.has(payload.sourceType) ? payload.sourceType : "document";
  const sourceAuthority = typeof payload.sourceAuthority === "string" && payload.sourceAuthority.trim()
    ? payload.sourceAuthority.trim().slice(0, 120)
    : "internal";
  const status = payload.status === "approved" ? "approved" : "draft";
  const versionLabel = typeof payload.versionLabel === "string" ? payload.versionLabel.trim().slice(0, 120) : null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const metadataSize = JSON.stringify(metadata).length;

  if (!projectKey) return NextResponse.json({ error: "projectKey must be DMI_HFC, UJJIVAN_SFB, or INDIA_BFCI_SHARED." }, { status: 400 });
  if (!title || content.length < 30 || content.length > 80000) {
    return NextResponse.json({ error: "Provide a title and 30–80,000 characters of source text." }, { status: 400 });
  }
  if (metadataSize > 8000) return NextResponse.json({ error: "metadata must be under 8 KB." }, { status: 413 });
  if (sourceUrl) {
    try {
      const parsedUrl = new URL(sourceUrl);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") throw new Error("Unsupported URL scheme.");
    } catch {
      return NextResponse.json({ error: "sourceUrl must be a valid HTTP(S) URL." }, { status: 400 });
    }
  }
  const database = config();
  if (!database) return NextResponse.json({ error: "Supabase server credentials are not configured." }, { status: 503 });

  const chunks = chunkText(content);
  if (!chunks.length || chunks.length > 120) return NextResponse.json({ error: "The source exceeds the supported chunk limit." }, { status: 413 });
  const documentId = randomUUID();
  try {
    const embeddings = await generateBudgetedEmbeddings(chunks);
    const document = {
      id: documentId,
      project_key: projectKey,
      title,
      source_url: sourceUrl,
      source_type: sourceType,
      source_authority: sourceAuthority,
      published_at: dateOrNull(payload.publishedAt),
      effective_at: dateOrNull(payload.effectiveAt),
      last_verified_at: dateOrNull(payload.lastVerifiedAt) || new Date().toISOString().slice(0, 10),
      version_label: versionLabel,
      status,
      metadata,
    };
    const docResponse = await fetch(database.url + "/rest/v1/uxd_knowledge_documents", {
      method: "POST",
      headers: dbHeaders(database.key, "return=minimal"),
      body: JSON.stringify(document),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!docResponse.ok) {
      return NextResponse.json({ error: "Could not save knowledge document (HTTP " + docResponse.status + ")." }, { status: 502 });
    }

    const chunkRows = chunks.map((chunk, index) => ({
      document_id: documentId,
      project_key: projectKey,
      chunk_index: index,
      content: chunk,
      content_hash: createHash("sha256").update(chunk).digest("hex"),
      embedding: embeddings[index],
      metadata: { chunkIndex: index, ...(isRecord(metadata) ? metadata : {}) },
    }));
    const chunkResponse = await fetch(database.url + "/rest/v1/uxd_knowledge_chunks", {
      method: "POST",
      headers: dbHeaders(database.key, "return=minimal"),
      body: JSON.stringify(chunkRows),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!chunkResponse.ok) {
      await fetch(database.url + "/rest/v1/uxd_knowledge_documents?id=eq." + encodeURIComponent(documentId), {
        method: "DELETE",
        headers: dbHeaders(database.key),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      }).catch(() => undefined);
      return NextResponse.json({ error: "Could not save embedded knowledge chunks (HTTP " + chunkResponse.status + ")." }, { status: 502 });
    }

    return NextResponse.json({
      accepted: true,
      documentId,
      projectKey,
      title,
      status,
      chunksCreated: chunks.length,
      embeddingModel: "openai/text-embedding-3-small",
      note: status === "approved"
        ? "The source is available to project-aware retrieval."
        : "The source is stored as draft and will not be retrieved until approved.",
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message.slice(0, 300) : "Knowledge ingestion failed.",
      documentId,
      note: "No document row was saved unless ingestion had already passed embedding generation.",
    }, { status: 502 });
  }
}
