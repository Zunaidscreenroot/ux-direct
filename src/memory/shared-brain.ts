import { createHash, randomUUID } from "node:crypto";

export const BRAIN_SCOPES = [
  "UX_SHARED_BRAIN", "UX_DIRECT", "UX_AUDIT", "EXPRESS_COMPUTERS",
  "DMI_HFC", "UJJIVAN_SFB", "INDIA_BFCI_SHARED",
] as const;
export type BrainScope = (typeof BRAIN_SCOPES)[number];
export type BrainProduct = "ux-direct" | "ux-audit" | "figma-plugin" | "chatgpt" | "system";
export type BrainStatus = "draft" | "approved" | "rejected" | "archived";

const FEEDBACK_KINDS = [
  "general", "false_positive", "missed_issue", "severity_calibration",
  "recommendation_quality", "duplicate_finding", "benchmarking", "scope",
  "visual_evidence", "accessibility", "cost_optimization", "retrieval_quality",
  "workflow_quality", "other",
] as const;
const MEMORY_TYPES = [
  "product_requirement", "approved_pattern", "design_decision", "design_system_rule",
  "user_preference", "research_finding", "task_outcome", "open_question",
  "coaching_rule", "quality_heuristic", "evaluation_case", "domain_principle",
  "workflow_procedure", "failure_pattern", "tool_routing_rule",
] as const;
const DOCUMENT_TYPES = ["brief", "figma_reference", "design_decision", "regulation", "research", "design_system", "document", "quality_example"] as const;
const MAX_CONTEXT_CHARS = 5000;
const MAX_QUERY_CHARS = 4000;

export type BrainFeedbackInput = {
  sourceProduct: BrainProduct;
  scopeKey: BrainScope;
  feedbackKind: (typeof FEEDBACK_KINDS)[number];
  rawFeedback: string;
  summary?: string;
  title: string;
  normalizedRule: string;
  rationale?: string;
  keywords?: string[];
  examples?: unknown[];
  originalLanguage?: string;
  sourceAuditRef?: string;
  sourceFindingTitle?: string;
  idempotencyKey?: string;
};

export type BrainContextItem = {
  id: string;
  kind: "memory" | "knowledge";
  scope: string;
  title: string;
  content: string;
  source?: string;
  sourceUrl?: string;
  sourceAuthority?: string;
  memoryType?: string;
  confidence?: number;
  score: number;
};

function config() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_DATABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("UX Shared Brain requires SUPABASE_URL and a server-only Supabase service key.");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabaseRequest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(9000),
  });
  const bodyText = await response.text();
  let body: unknown = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText.slice(0, 500); }
  if (!response.ok) {
    const message = typeof body === "object" && body && "message" in body && typeof body.message === "string"
      ? body.message : `Supabase returned HTTP ${response.status}.`;
    throw new Error(message.slice(0, 500));
  }
  return body;
}

function requiredText(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error(`${name} must be between ${min} and ${max} characters.`);
  return text;
}
function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text || null;
}
function safeCount(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? Math.max(1, Math.min(max, n)) : fallback;
}
function safeScope(value: unknown): BrainScope {
  if (typeof value === "string" && (BRAIN_SCOPES as readonly string[]).includes(value)) return value as BrainScope;
  throw new Error("scopeKey must be a supported UX Shared Brain namespace.");
}
function safeSourceProduct(value: unknown): BrainProduct {
  if (typeof value === "string" && ["ux-direct", "ux-audit", "figma-plugin", "chatgpt", "system"].includes(value)) return value as BrainProduct;
  throw new Error("sourceProduct must identify UX Direct, UX Audit, the Figma plugin, ChatGPT, or the system.");
}
function words(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string")
    .map(v => v.trim().toLowerCase()).filter(v => v.length > 0 && v.length <= 80))].slice(0, 30);
}
function normalizeDedupeKey(scope: BrainScope, rule: string): string {
  const normalized = rule.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  return createHash("sha256").update(scope + "::" + normalized).digest("hex");
}
function queryPath(table: string, filters: Record<string, string>, select = "*", limit = 20): string {
  const params = new URLSearchParams({ select, ...filters, limit: String(Math.max(1, Math.min(100, limit))) });
  return `${table}?${params.toString()}`;
}

type Embedding = { model: string; vector: number[] };
async function embedText(text: string): Promise<Embedding | null> {
  const provider = (process.env.UXD_EMBEDDING_PROVIDER || "none").trim().toLowerCase();
  if (provider === "none" || !provider) return null;
  const model = process.env.UXD_EMBEDDING_MODEL?.trim() || (provider === "ollama" ? "nomic-embed-text" : "");
  if (!model) return null;
  const baseUrl = (provider === "ollama"
    ? process.env.UXD_EMBEDDING_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
    : process.env.UXD_EMBEDDING_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  try {
    let response: Response;
    let vector: unknown;
    if (provider === "ollama") {
      response = await fetch(baseUrl + "/api/embed", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text.slice(0, 6000) }), signal: AbortSignal.timeout(10000),
      });
      const payload = await response.json() as { embeddings?: unknown; embedding?: unknown };
      const values = Array.isArray(payload.embeddings) ? payload.embeddings[0] : payload.embedding;
      vector = values;
    } else if (provider === "openai-compatible") {
      const endpoint = baseUrl.endsWith("/embeddings") ? baseUrl : baseUrl + "/embeddings";
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.UXD_EMBEDDING_API_KEY ? { Authorization: "Bearer " + process.env.UXD_EMBEDDING_API_KEY } : {}),
        },
        body: JSON.stringify({ model, input: text.slice(0, 6000) }), signal: AbortSignal.timeout(10000),
      });
      const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
      vector = payload.data?.[0]?.embedding;
    } else {
      return null;
    }
    if (!response.ok || !Array.isArray(vector) || !vector.length || vector.length > 8192 ||
      !vector.every(v => typeof v === "number" && Number.isFinite(v))) return null;
    return { model, vector: vector as number[] };
  } catch {
    // Embeddings are optional. Keyword retrieval remains available and must not fail the request.
    return null;
  }
}
function vectorLiteral(values: number[]) {
  return "[" + values.map(v => Number(v.toFixed(7))).join(",") + "]";
}

function fuseResults(pools: Array<{ kind: "memory" | "knowledge"; rows: any[] }>, limit: number): BrainContextItem[] {
  const combined = new Map<string, BrainContextItem>();
  pools.forEach(pool => {
    pool.rows.forEach((row, idx) => {
      const id = String(pool.kind === "memory" ? row.memory_id ?? row.id ?? "" : row.chunk_id ?? row.id ?? "");
      if (!id) return;
      const key = pool.kind + ":" + id;
      const prior = combined.get(key);
      const rrf = 1 / (60 + idx + 1);
      const baseContent = String(row.content || "").trim();
      const structured = row.structured_data && typeof row.structured_data === "object" ? row.structured_data as Record<string, unknown> : {};
      const rationale = pool.kind === "memory" && typeof structured.rationale === "string" ? structured.rationale.trim() : "";
      const examples = pool.kind === "memory" && Array.isArray(structured.examples)
        ? structured.examples.filter((example: unknown): example is string => typeof example === "string").slice(0, 2).map((example: string) => "Calibration example (not evidence): " + example.trim().slice(0, 260))
        : [];
      const content = [baseContent, rationale ? "Rationale: " + rationale : "", ...examples].filter(Boolean).join("\\n").slice(0, 9000);
      const item: BrainContextItem = prior || {
        id,
        kind: pool.kind,
        scope: String(row.project_key || ""),
        title: String(row.title || "Untitled knowledge"),
        content,
        source: pool.kind === "memory" ? String(row.source_product || row.source || "") : "",
        sourceUrl: String(row.source_url || "") || undefined,
        sourceAuthority: String(row.source_authority || "") || undefined,
        memoryType: String(row.memory_type || "") || undefined,
        confidence: typeof row.confidence === "number" ? row.confidence : undefined,
        score: 0,
      };
      item.score += rrf;
      if (content.length > item.content.length) item.content = content;
      combined.set(key, item);
    });
  });
  return [...combined.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function renderContext(items: BrainContextItem[], maxChars: number): string {
  const chunks: string[] = [];
  let remaining = Math.max(0, Math.min(MAX_CONTEXT_CHARS, maxChars));
  for (const item of items) {
    if (remaining < 120) break;
    const title = item.title.slice(0, 160);
    const content = item.content.replace(/\s+/g, " ").slice(0, Math.min(850, remaining - 100));
    const header = item.kind === "memory"
      ? `[APPROVED ${item.memoryType || "product memory"} | scope:${item.scope} | source:${item.source || "brain"}]`
      : `[APPROVED REFERENCE | scope:${item.scope} | authority:${item.sourceAuthority || "unspecified"} | source:${item.sourceUrl || "stored reference"}]`;
    const block = `${header} ${title}: ${content}`;
    chunks.push(block);
    remaining -= block.length + 2;
  }
  return chunks.join("\n\n").slice(0, maxChars);
}

export async function retrieveBrainContext(input: {
  query: unknown; scopeKey: unknown; relatedScopes?: unknown; maxResults?: unknown; maxContextChars?: unknown; includeKnowledge?: boolean;
}) {
  const query = requiredText(input.query, "query", MAX_QUERY_CHARS, 2);
  const scopeKey = safeScope(input.scopeKey);
  const requestedRelated = Array.isArray(input.relatedScopes) ? input.relatedScopes : [];
  const relatedScopes = [...new Set(requestedRelated
    .filter((value): value is string => typeof value === "string")
    .map(value => safeScope(value))
    .filter(value => value !== scopeKey))].slice(0, 2);
  const scopes = [scopeKey, ...relatedScopes];
  const maxResults = safeCount(input.maxResults, 8, 10);
  const maxContextChars = safeCount(input.maxContextChars, MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS);
  const count = Math.min(10, Math.max(6, maxResults));
  const queryShort = query.slice(0, MAX_QUERY_CHARS);

  // One bounded keyword request per relevant scope; no model call is needed for keyword retrieval.
  const keywordJobs: Array<{kind:"memory"|"knowledge";scope:BrainScope;promise:Promise<unknown>}> = [];
  for (const scope of scopes) {
    keywordJobs.push({kind:"memory",scope,promise:supabaseRequest("rpc/search_uxd_brain_memory_keyword",{
      method:"POST",body:JSON.stringify({p_project_key:scope,p_query:queryShort,p_match_count:count})
    })});
    if (input.includeKnowledge !== false) {
      keywordJobs.push({kind:"knowledge",scope,promise:supabaseRequest("rpc/search_uxd_brain_knowledge_keyword",{
        method:"POST",body:JSON.stringify({p_project_key:scope,p_query:queryShort,p_match_count:count})
      })});
    }
  }
  const keywordResults = await Promise.all(keywordJobs.map(job=>job.promise.catch(()=>[])));
  const pools: Array<{kind:"memory"|"knowledge";rows:any[]}> = keywordResults.map((rows,index)=>({
    kind:keywordJobs[index].kind,
    rows:Array.isArray(rows)?rows as any[]:[]
  }));

  // Embeddings are opt-in. If enabled, calculate the query vector once and use it across scopes.
  const embedding = await embedText(queryShort);
  if (embedding) {
    const vector = vectorLiteral(embedding.vector);
    const semanticJobs: Array<{kind:"memory"|"knowledge";scope:BrainScope;promise:Promise<unknown>}> = [];
    for (const scope of scopes) {
      semanticJobs.push({kind:"memory",scope,promise:supabaseRequest("rpc/match_uxd_brain_memory",{
        method:"POST",body:JSON.stringify({
          p_query_embedding:vector,p_embedding_model:embedding.model,p_project_key:scope,
          p_match_count:count,p_min_similarity:0.28,
        })
      })});
      if (input.includeKnowledge !== false) {
        semanticJobs.push({kind:"knowledge",scope,promise:supabaseRequest("rpc/match_uxd_brain_knowledge",{
          method:"POST",body:JSON.stringify({
            p_query_embedding:vector,p_embedding_model:embedding.model,p_project_key:scope,
            p_match_count:count,p_min_similarity:0.28,
          })
        })});
      }
    }
    const semanticResults = await Promise.all(semanticJobs.map(job=>job.promise.catch(()=>[])));
    for (let index=0;index<semanticResults.length;index++) {
      pools.push({kind:semanticJobs[index].kind,rows:Array.isArray(semanticResults[index])?semanticResults[index] as any[]:[]});
    }
  }

  const items = fuseResults(pools,maxResults);
  const context = renderContext(items,maxContextChars);
  return {
    scopeKey,relatedScopes,retrievalMode:embedding?"hybrid-keyword-vector-rrf":"keyword-full-text",
    embeddingModel:embedding?.model??null,
    memoryCount:items.filter(i=>i.kind==="memory").length,
    knowledgeCount:items.filter(i=>i.kind==="knowledge").length,
    memoryIds:items.filter(i=>i.kind==="memory").map(i=>i.id),
    documentChunkIds:items.filter(i=>i.kind==="knowledge").map(i=>i.id),
    context,
    items:items.map(({score,content,...rest})=>({...rest,score:Number(score.toFixed(5)),excerpt:content.slice(0,900)})),
    contextCharacters:context.length,contextBudgetCharacters:maxContextChars,
  };
}

function toFeedbackRow(row: any) {
  return {
    id: String(row.id), sourceProduct: String(row.source_product), scopeKey: String(row.scope_key),
    feedbackKind: String(row.feedback_kind), rawFeedback: String(row.raw_feedback || ""),
    summary: String(row.summary || ""), title: String(row.title || ""),
    normalizedRule: String(row.normalized_rule || ""), rationale: String(row.rationale || ""),
    keywords: Array.isArray(row.keywords) ? row.keywords : [], examples: Array.isArray(row.examples) ? row.examples : [],
    originalLanguage: String(row.original_language || "unknown"), sourceAuditRef: row.source_audit_ref || null,
    sourceFindingTitle: row.source_finding_title || null, memoryItemId: row.memory_item_id || null,
    status: String(row.status), reviewNote: row.review_note || null, createdAt: row.created_at, updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at || null,
  };
}

export async function saveBrainFeedback(input: BrainFeedbackInput) {
  const sourceProduct = safeSourceProduct(input.sourceProduct);
  const scopeKey = safeScope(input.scopeKey);
  if (!(FEEDBACK_KINDS as readonly string[]).includes(input.feedbackKind)) throw new Error("Unsupported feedbackKind.");
  const rawFeedback = requiredText(input.rawFeedback, "rawFeedback", 8000);
  const title = requiredText(input.title, "title", 240);
  const normalizedRule = requiredText(input.normalizedRule, "normalizedRule", 2000);
  const rationale = optionalText(input.rationale, 1400) || "";
  const summary = optionalText(input.summary, 1400) || "";
  const keywords = words(input.keywords);
  const examples = Array.isArray(input.examples) ? input.examples.slice(0, 6).map(item => typeof item === "string" ? item.slice(0, 800) : item) : [];
  const idempotencyKey = optionalText(input.idempotencyKey, 180);
  if (idempotencyKey) {
    const existing = await supabaseRequest(queryPath("uxd_brain_feedback", { idempotency_key: "eq." + idempotencyKey }, "*", 1)).catch(() => []);
    if (Array.isArray(existing) && existing[0]) return { ...toFeedbackRow(existing[0]), duplicateRequest: true };
  }

  const feedback = {
    source_product: sourceProduct, scope_key: scopeKey, feedback_kind: input.feedbackKind,
    raw_feedback: rawFeedback, summary, title, normalized_rule: normalizedRule, rationale, keywords, examples,
    original_language: optionalText(input.originalLanguage, 40) || "unknown",
    source_audit_ref: optionalText(input.sourceAuditRef, 300),
    source_finding_title: optionalText(input.sourceFindingTitle, 240),
    status: "draft", idempotency_key: idempotencyKey,
    metadata: { memoryCreated: false, coachingMechanism: "approved-retrieval", schemaVersion: 1 },
    updated_at: new Date().toISOString(),
  };
  const inserted = await supabaseRequest("uxd_brain_feedback", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(feedback),
  });
  const saved = Array.isArray(inserted) ? inserted[0] : null;
  if (!saved?.id) throw new Error("UX Shared Brain did not return the saved feedback record.");

  const dedupeKey = normalizeDedupeKey(scopeKey, normalizedRule);
  let memoryItemId: string | null = null;
  let createdMemory = false;
  const existingMemory = await supabaseRequest(queryPath("uxd_memory_items", { dedupe_key: "eq." + dedupeKey }, "id,status", 1)).catch(() => []);
  if (Array.isArray(existingMemory) && existingMemory[0]?.id) {
    memoryItemId = String(existingMemory[0].id);
  } else {
    const ruleEmbedding = await embedText([title, normalizedRule, rationale, keywords.join(" ")].filter(Boolean).join("\\n"));
  const memoryPayload = {
      project_key: scopeKey, memory_type: "coaching_rule", title, content: normalizedRule,
      ...(ruleEmbedding ? { embedding: vectorLiteral(ruleEmbedding.vector), embedding_model: ruleEmbedding.model } : {}),
      structured_data: {
        rationale, feedbackKind: input.feedbackKind, examples, originalLanguage: feedback.original_language,
        sourceProduct, sourceFeedbackId: saved.id, sourceAuditRef: feedback.source_audit_ref,
        sourceFindingTitle: feedback.source_finding_title,
      },
      tags: keywords, source: sourceProduct === "ux-audit" ? "ux-audit" : sourceProduct === "figma-plugin" ? "figma-plugin" : "chatgpt-coaching",
      source_product: sourceProduct, source_reference: feedback.source_audit_ref || String(saved.id),
      dedupe_key: dedupeKey, confidence: 0.8, status: "draft", usage_count: 0,
    };
    try {
      const memoryResult = await supabaseRequest("uxd_memory_items", {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(memoryPayload),
      });
      const memory = Array.isArray(memoryResult) ? memoryResult[0] : null;
      if (memory?.id) { memoryItemId = String(memory.id); createdMemory = true; }
    } catch (error) {
      // Preserve coaching even if the derived memory could not be materialized; it can be retried.
      console.warn("[uxd-brain] draft memory creation failed", error instanceof Error ? error.message.slice(0, 160) : "unknown");
    }
  }

  if (memoryItemId) {
    await supabaseRequest("uxd_brain_feedback?id=eq." + encodeURIComponent(String(saved.id)), {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        memory_item_id: memoryItemId,
        metadata: { ...feedback.metadata, memoryCreated: createdMemory },
        updated_at: new Date().toISOString(),
      }),
    });
  }
  return { ...toFeedbackRow({ ...saved, memory_item_id: memoryItemId }), activeForRetrieval: false, draftMemoryCreated: createdMemory };
}

export async function listBrainFeedback(input: { scopeKey?: unknown; status?: unknown; sourceProduct?: unknown; limit?: unknown } = {}) {
  const limit = safeCount(input.limit, 30, 100);
  const filters: Record<string, string> = {};
  if (input.scopeKey !== undefined) filters.scope_key = "eq." + safeScope(input.scopeKey);
  if (input.status !== undefined && input.status !== "all") {
    if (typeof input.status !== "string" || !["draft", "approved", "rejected", "archived"].includes(input.status)) throw new Error("Unsupported feedback status.");
    filters.status = "eq." + input.status;
  }
  if (input.sourceProduct !== undefined) filters.source_product = "eq." + safeSourceProduct(input.sourceProduct);
  const rows = await supabaseRequest(queryPath("uxd_brain_feedback", filters, "*", limit));
  return Array.isArray(rows) ? rows.map(toFeedbackRow) : [];
}

export async function reviewBrainFeedback(input: { feedbackId: unknown; action: unknown; reviewNote?: unknown }) {
  const feedbackId = requiredText(input.feedbackId, "feedbackId", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(feedbackId)) throw new Error("feedbackId must be a UUID.");
  const action = input.action;
  if (typeof action !== "string" || !["approve", "reject", "archive"].includes(action)) throw new Error("action must be approve, reject, or archive.");
  const rows = await supabaseRequest(queryPath("uxd_brain_feedback", { id: "eq." + feedbackId }, "*", 1));
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error("Coaching feedback was not found.");
  const now = new Date().toISOString();
  const status: BrainStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "archived";
  let memoryId: string | null = row.memory_item_id ? String(row.memory_item_id) : null;

  if (status === "approved" && !memoryId) {
    const dedupeKey = normalizeDedupeKey(row.scope_key as BrainScope, row.normalized_rule);
    const ruleEmbedding = await embedText([row.title, row.normalized_rule, row.rationale || "", ...(Array.isArray(row.keywords) ? row.keywords : [])].filter(Boolean).join("\\n"));
    const sourceProduct = ["ux-direct", "ux-audit", "figma-plugin", "chatgpt", "system"].includes(String(row.source_product)) ? String(row.source_product) : "chatgpt";
    const created = await supabaseRequest("uxd_memory_items", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        project_key: row.scope_key, memory_type: "coaching_rule", title: row.title, content: row.normalized_rule,
        ...(ruleEmbedding ? { embedding: vectorLiteral(ruleEmbedding.vector), embedding_model: ruleEmbedding.model } : {}),
        structured_data: { rationale: row.rationale, feedbackKind: row.feedback_kind, examples: row.examples, sourceFeedbackId: row.id, sourceProduct: row.source_product },
        tags: row.keywords || [], source: sourceProduct === "ux-audit" ? "ux-audit" : sourceProduct === "figma-plugin" ? "figma-plugin" : "chatgpt-coaching", source_product: sourceProduct,
        source_reference: row.source_audit_ref || String(row.id), dedupe_key: dedupeKey,
        confidence: 0.8, status: "draft", usage_count: 0,
      }),
    });
    const memory = Array.isArray(created) ? created[0] : null;
    if (!memory?.id) throw new Error("Could not materialize the approved learning as a memory item.");
    memoryId = String(memory.id);
  }

  const updated = await supabaseRequest("uxd_brain_feedback?id=eq." + encodeURIComponent(feedbackId), {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      status, review_note: optionalText(input.reviewNote, 1000), reviewed_at: now, updated_at: now,
      memory_item_id: memoryId,
    }),
  });
  const result = Array.isArray(updated) ? updated[0] : null;
  if (!result) throw new Error("Feedback review did not return an updated record.");

  const memoryCreated = Boolean(row.metadata?.memoryCreated);
  if (memoryId && (status === "approved" || (memoryCreated && status !== "approved"))) {
    await supabaseRequest("uxd_memory_items?id=eq." + encodeURIComponent(memoryId), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: status === "approved" ? "approved" : "archived",
        approved_at: status === "approved" ? now : null,
        archived_at: status === "approved" ? null : now,
        updated_at: now,
      }),
    });
  }
  return { ...toFeedbackRow(result), activeForRetrieval: status === "approved", memoryItemId: memoryId };
}

export async function upsertBrainDocument(input: {
  scopeKey: unknown; title: unknown; content: unknown; sourceUrl?: unknown;
  sourceType?: unknown; sourceAuthority?: unknown; publishedAt?: unknown; effectiveAt?: unknown;
  lastVerifiedAt?: unknown; versionLabel?: unknown; metadata?: unknown; activate?: unknown;
}) {
  const scopeKey = safeScope(input.scopeKey);
  const title = requiredText(input.title, "title", 300);
  const content = requiredText(input.content, "content", 180000);
  const sourceUrl = optionalText(input.sourceUrl, 2000);
  const sourceType = optionalText(input.sourceType, 40) || "document";
  if (!(DOCUMENT_TYPES as readonly string[]).includes(sourceType)) throw new Error("Unsupported sourceType.");
  const authority = optionalText(input.sourceAuthority, 100) || "internal";
  const activate = input.activate === true;
  const now = new Date().toISOString();
  const docMetadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? input.metadata as Record<string, unknown> : {};
  const documentRows = await supabaseRequest("uxd_knowledge_documents", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      project_key: scopeKey, title, source_url: sourceUrl, source_type: sourceType,
      source_authority: authority, published_at: optionalText(input.publishedAt, 30),
      effective_at: optionalText(input.effectiveAt, 30), last_verified_at: optionalText(input.lastVerifiedAt, 30),
      version_label: optionalText(input.versionLabel, 120), status: activate ? "approved" : "draft",
      metadata: { ...docMetadata, ingestedBy: "uxd-shared-brain", ingestedAt: now, contentHash: createHash("sha256").update(content).digest("hex") },
      updated_at: now,
    }),
  });
  const document = Array.isArray(documentRows) ? documentRows[0] : null;
  if (!document?.id) throw new Error("Knowledge document did not save.");

  const chunks: string[] = [];
  const chunkSize = 9000, overlap = 450;
  for (let start = 0; start < content.length && chunks.length < 60; start += chunkSize - overlap) {
    chunks.push(content.slice(start, start + chunkSize));
  }
  const vectorEnabled = (process.env.UXD_EMBEDDING_PROVIDER || "none").trim().toLowerCase() !== "none";
  const chunkRows = [];
  for (let index = 0; index < chunks.length; index++) {
    const piece = chunks[index];
    const embedding = vectorEnabled ? await embedText(title + "\n\n" + piece) : null;
    chunkRows.push({
      document_id: document.id, project_key: scopeKey, chunk_index: index,
      content: piece, content_hash: createHash("sha256").update(piece).digest("hex"),
      ...(embedding ? { embedding: vectorLiteral(embedding.vector), embedding_model: embedding.model } : {}),
      metadata: { documentTitle: title, sourceAuthority: authority, sourceUrl: sourceUrl || "", chunkCount: chunks.length },
    });
  }
  await supabaseRequest("uxd_knowledge_chunks", {
    method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(chunkRows),
  });
  return { id: String(document.id), title, scopeKey, sourceUrl, sourceAuthority: authority, status: activate ? "approved" : "draft", chunkCount: chunks.length, embeddingsStored: chunkRows.filter(r => "embedding" in r).length };
}

export async function saveBrainEvalCase(input: {
  scopeKey: unknown; capability?: unknown; title: unknown; query: unknown;
  expectedBehavior?: unknown; forbiddenBehaviors?: unknown; expectedMemoryIds?: unknown; expectedKnowledgeChunkIds?: unknown; activate?: unknown;
}) {
  const scopeKey = safeScope(input.scopeKey);
  const title = requiredText(input.title, "title", 240);
  const query = requiredText(input.query, "query", 8000);
  const forbiddenBehaviors = words(input.forbiddenBehaviors);
  const expectedMemoryIds = Array.isArray(input.expectedMemoryIds)
    ? input.expectedMemoryIds.filter((v): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)).slice(0, 20) : [];
  const expectedKnowledgeChunkIds = Array.isArray(input.expectedKnowledgeChunkIds)
    ? input.expectedKnowledgeChunkIds.filter((v): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)).slice(0, 20) : [];
  const activate = input.activate === true;
  const now = new Date().toISOString();
  const rows = await supabaseRequest("uxd_brain_eval_cases", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      scope_key: scopeKey, capability: optionalText(input.capability, 80) || "retrieval",
      title, input: query, expected_behavior: optionalText(input.expectedBehavior, 2000) || "",
      forbidden_behaviors: forbiddenBehaviors, expected_memory_ids: expectedMemoryIds,
      expected_knowledge_chunk_ids: expectedKnowledgeChunkIds,
      status: activate ? "approved" : "draft", source: "human-approved", updated_at: now,
    }),
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw new Error("Evaluation case did not save.");
  return { id: String(row.id), title, scopeKey, status: String(row.status), activated: activate, expectedMemoryCount: expectedMemoryIds.length, expectedKnowledgeChunkCount: expectedKnowledgeChunkIds.length };
}

export async function runBrainRetrievalEvaluations(input: { scopeKey?: unknown; limit?: unknown } = {}) {
  const scopeKey = input.scopeKey === undefined ? undefined : safeScope(input.scopeKey);
  const limit = safeCount(input.limit, 20, 100);
  const filters: Record<string, string> = { status: "eq.approved" };
  if (scopeKey) filters.scope_key = "eq." + scopeKey;
  const cases = await supabaseRequest(queryPath("uxd_brain_eval_cases", filters, "*", limit));
  if (!Array.isArray(cases) || !cases.length) return { count: 0, passed: 0, recallAtK: null, message: "No approved retrieval evaluation cases have been saved." };
  const results: Array<Record<string, unknown>> = [];
  for (const row of cases) {
    const retrieved = await retrieveBrainContext({
      query: row.input, scopeKey: row.scope_key, maxResults: 10, maxContextChars: 3000,
    });
    const expected: string[] = Array.isArray(row.expected_memory_ids) ? row.expected_memory_ids : [];
    const expectedKnowledge: string[] = Array.isArray(row.expected_knowledge_chunk_ids) ? row.expected_knowledge_chunk_ids : [];
    const memoryHits = expected.filter(id => retrieved.memoryIds.includes(id));
    const knowledgeHits = expectedKnowledge.filter(id => retrieved.documentChunkIds.includes(id));
    const totalExpected = expected.length + expectedKnowledge.length;
    const totalHits = memoryHits.length + knowledgeHits.length;
    const text = retrieved.context.toLowerCase();
    const forbiddenHits = (Array.isArray(row.forbidden_behaviors) ? row.forbidden_behaviors : [])
      .filter((needle: string) => needle && text.includes(String(needle).toLowerCase()));
    const pass = totalExpected ? totalHits === totalExpected && forbiddenHits.length === 0 : forbiddenHits.length === 0;
    const recall = totalExpected ? totalHits / totalExpected : null;
    const report = {
      passed: pass,
      expectedCount: totalExpected,
      expectedMemoryCount: expected.length,
      expectedKnowledgeCount: expectedKnowledge.length,
      retrievedExpectedCount: totalHits,
      retrievedExpectedMemoryCount: memoryHits.length,
      retrievedExpectedKnowledgeCount: knowledgeHits.length,
      missingMemoryIds: expected.filter(id => !memoryHits.includes(id)),
      missingKnowledgeChunkIds: expectedKnowledge.filter(id => !knowledgeHits.includes(id)),
      recallAtK: recall,
      forbiddenHits,
      retrievedMemoryCount: retrieved.memoryCount,
      retrievedKnowledgeCount: retrieved.knowledgeCount,
      contextCharacters: retrieved.contextCharacters,
      retrievalMode: retrieved.retrievalMode,
      completedAt: new Date().toISOString(),
    };
    await supabaseRequest("uxd_brain_eval_cases?id=eq." + encodeURIComponent(String(row.id)), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_run_at: report.completedAt, last_run_result: report, updated_at: report.completedAt }),
    });
    results.push({ id: String(row.id), title: String(row.title), ...report });
  }
  const recallValues = results.map(r => r.recallAtK).filter((v): v is number => typeof v === "number");
  return {
    count: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    recallAtK: recallValues.length ? Number((recallValues.reduce((a,b) => a+b, 0) / recallValues.length).toFixed(3)) : null,
    results,
  };
}

export async function listBrainEvalCases(input: { scopeKey?: unknown; status?: unknown; limit?: unknown } = {}) {
  const filters: Record<string, string> = {};
  if (input.scopeKey !== undefined) filters.scope_key = "eq." + safeScope(input.scopeKey);
  if (input.status !== undefined && input.status !== "all") {
    if (typeof input.status !== "string" || !["draft", "approved", "archived"].includes(input.status)) throw new Error("Unsupported evaluation status.");
    filters.status = "eq." + input.status;
  }
  const rows = await supabaseRequest(queryPath("uxd_brain_eval_cases", filters, "*", safeCount(input.limit, 30, 100)));
  return Array.isArray(rows) ? rows : [];
}
