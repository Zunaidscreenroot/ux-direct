import { createHash } from "node:crypto";
import { assessBrainRelevance } from "./learning-signal";
import { neonRequest as supabaseRequest } from "./neon-rest";

export type BrainMemory = {
  id: string;
  project_key: string;
  memory_type: string;
  title: string;
  content: string;
  structured_data: Record<string, unknown>;
  tags: string[];
  source: string;
  source_product: string;
  source_reference?: string | null;
  confidence: number;
  usage_count: number;
  relevance?: number;
};

export type BrainKnowledgeChunk = {
  document_id: string;
  chunk_id: string;
  project_key: string;
  title: string;
  source_url?: string | null;
  source_type: string;
  source_authority: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  relevance: number;
};

export type BrainContext = {
  memories: BrainMemory[];
  knowledge: BrainKnowledgeChunk[];
  contextText: string;
  retrieval: {
    status: "complete" | "empty" | "degraded" | "disabled";
    memoryCount: number;
    knowledgeChunkCount: number;
    maxChars: number;
    memoryIds: string[];
    chunkIds: string[];
    chars: number;
  };
};

export type BrainFeedbackInput = {
  rawFeedback: string;
  summary?: string;
  title: string;
  normalizedRule: string;
  rationale?: string;
  scopeKey?: string;
  feedbackKind?: string;
  keywords?: string[];
  examples?: unknown[];
  originalLanguage?: string;
  sourceProduct: string;
  sourceAuditRef?: string;
  sourceFindingTitle?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

const MAX_CONTEXT_CHARS = 5200;
const MAX_MEMORIES = 10;
const MAX_CHUNKS = 8;
const ALLOWED_SOURCES = new Set(["ux-direct", "ux-audit", "figma-plugin", "chatgpt", "local-model", "benchmark", "knowledge-ingestion"]);
const FEEDBACK_KINDS = new Set([
  "general", "false_positive", "missed_issue", "severity_calibration",
  "recommendation_quality", "duplicate_finding", "benchmarking", "scope",
  "visual_evidence", "accessibility", "interaction_logic", "design_system",
  "cost_optimization", "other",
]);

function textValue(value: unknown, max: number, label: string, required = false): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${label} is required.`);
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return result;
}

function normalizeScope(value: unknown): string {
  const scope = textValue(value, 100, "scopeKey") || "UX_SHARED_BRAIN";
  if (scope === "UX_SHARED_BRAIN") return scope;
  if (!/^[a-z0-9][a-z0-9:_-]{0,99}$/i.test(scope)) {
    throw new Error("scopeKey must be a compact scope identifier (e.g. UX_SHARED_BRAIN, indian-bfsi, project:dmi-finance).");
  }
  return scope.toLowerCase();
}

function normalizeSource(value: unknown): string {
  const source = textValue(value, 40, "sourceProduct", true).toLowerCase();
  if (!ALLOWED_SOURCES.has(source)) throw new Error("sourceProduct must identify a known first-party product or ingestion path.");
  return source;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim().toLowerCase())
    .filter(item => item.length > 0 && item.length <= 64))].slice(0, 32);
}

function normalizeExamples(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(item => {
    if (typeof item === "string") return item.trim().slice(0, 600);
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item as Record<string, unknown>).slice(0, 12);
      return Object.fromEntries(entries.map(([key, entry]) => [key.slice(0, 60), typeof entry === "string" ? entry.slice(0, 600) : entry]));
    }
    return String(item).slice(0, 300);
  });
}

function safeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Remove seed-era memory that conflicts with the owner's current universal
 * auto-learning policy. Keep the Past Findings/Knowledge Base distinction while
 * replacing its obsolete manual-approval clause in runtime retrieval.
 */
export function sanitizeLegacyLearningPolicyMemory(memory: BrainMemory): BrainMemory | null {
  const id = String(memory.id || "").toLowerCase();
  const title = String(memory.title || "").trim().toLowerCase();
  const reference = String(memory.source_reference || "").toLowerCase();

  if (
    id === "ef64b595-7f6b-4786-a799-c3e7e5a1015b" ||
    title === "selective learning from conversational feedback" ||
    reference === "owner-request:chat-learning-policy:2026-10-18"
  ) {
    return null;
  }

  if (title === "past findings versus knowledge base") {
    const content = String(memory.content || "").replace(
      /Keep new feedback and reference documents as drafts until explicitly reviewed and approved\.?/i,
      "Eligible reusable feedback and relevant research may auto-activate after deterministic relevance, scope, privacy and deduplication checks; no manual approval step is required."
    );
    return content === memory.content ? memory : { ...memory, content };
  }

  return memory;
}

function compactContext(memories: BrainMemory[], knowledge: BrainKnowledgeChunk[], maxChars = MAX_CONTEXT_CHARS): string {
  const sections: string[] = [];
  for (const memory of memories.slice(0, MAX_MEMORIES)) {
    const header = `[Approved product memory · scope: ${memory.project_key} · type: ${memory.memory_type} · origin: ${memory.source_product}] ${memory.title}`;
    const body = String(memory.content || "").replace(/\s+/g, " ").slice(0, 620);
    const tags = Array.isArray(memory.tags) && memory.tags.length ? ` Tags: ${memory.tags.slice(0, 8).join(", ")}.` : "";
    sections.push(`${header}\n${body}${tags}`);
  }
  for (const chunk of knowledge.slice(0, MAX_CHUNKS)) {
    const source = chunk.source_url ? ` Source: ${chunk.source_url}` : "";
    sections.push(`[Approved reference · scope: ${chunk.project_key} · ${chunk.source_authority}] ${chunk.title}${source}\n${String(chunk.content || "").replace(/\s+/g, " ").slice(0, 700)}`);
  }
  let context = "";
  for (const section of sections) {
    const next = context ? context + "\n\n" + section : section;
    if (next.length > maxChars) {
      const remaining = maxChars - context.length - (context ? 2 : 0);
      if (remaining > 180) context = (context ? context + "\n\n" : "") + section.slice(0, remaining);
      break;
    }
    context = next;
  }
  return context;
}

export async function retrieveBrainContext(input: {
  query: string;
  scopeKeys: string[];
  limit?: number;
  memoryTypes?: string[];
  maxChars?: number;
  includeKnowledge?: boolean;
}): Promise<BrainContext> {
  const query = textValue(input.query, 8000, "query");
  const scopeKeys = [...new Set((input.scopeKeys.length ? input.scopeKeys : ["UX_SHARED_BRAIN"]).map(normalizeScope))].slice(0, 12);
  const limit = Math.max(1, Math.min(12, Math.floor(input.limit ?? 6)));
  const maxChars = Math.max(600, Math.min(MAX_CONTEXT_CHARS, Math.floor(input.maxChars ?? MAX_CONTEXT_CHARS)));
  try {
    const memoryPromise = supabaseRequest("rpc/uxd_brain_search_memories", {
      method: "POST",
      body: JSON.stringify({
        p_query: query,
        p_scope_keys: scopeKeys,
        p_limit: limit,
        p_memory_types: Array.isArray(input.memoryTypes) && input.memoryTypes.length ? input.memoryTypes.slice(0, 12) : null,
      }),
    });
    let knowledgeFailed = false;
    const knowledgePromise = input.includeKnowledge === false
      ? Promise.resolve([])
      : supabaseRequest("rpc/uxd_brain_search_knowledge", {
          method: "POST",
          body: JSON.stringify({ p_query: query, p_scope_keys: scopeKeys, p_limit: Math.min(MAX_CHUNKS, limit) }),
        }).catch((error) => {
          knowledgeFailed = true;
          console.warn("[uxd-brain] knowledge retrieval degraded:", error instanceof Error ? error.message.slice(0, 180) : "unknown");
          return [];
        });
    const [memoryResult, knowledgeResult] = await Promise.all([memoryPromise, knowledgePromise]);
    const memories = (Array.isArray(memoryResult) ? memoryResult as BrainMemory[] : [])
      .map(sanitizeLegacyLearningPolicyMemory)
      .filter((memory): memory is BrainMemory => memory !== null);
    const knowledge = Array.isArray(knowledgeResult) ? knowledgeResult as BrainKnowledgeChunk[] : [];
    const contextText = compactContext(memories, knowledge, maxChars);
    const memoryIds = memories.map(memory => memory.id).filter(safeUuid);
    if (memoryIds.length) {
      // Await the write so Cloudflare can finish it before the request lifecycle ends.
      // Tracking failure must not make otherwise-valid retrieval fail.
      await supabaseRequest("rpc/uxd_brain_mark_used", {
        method: "POST",
        body: JSON.stringify({ ids: memoryIds }),
      }).catch(error => console.warn("[uxd-brain] usage tracking failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown"));
    }
    return {
      memories, knowledge, contextText,
      retrieval: {
        status: knowledgeFailed ? "degraded" : memories.length || knowledge.length ? "complete" : "empty",
        memoryCount: memories.length,
        knowledgeChunkCount: knowledge.length,
        maxChars,
        memoryIds,
        chunkIds: knowledge.map(chunk => chunk.chunk_id).filter(Boolean),
        chars: contextText.length,
      },
    };
  } catch (error) {
    console.warn("[uxd-brain] retrieval degraded:", error instanceof Error ? error.message.slice(0, 200) : "unknown");
    const disabled = !process.env.DATABASE_URL && !process.env.POSTGRES_PRISMA_URL && !process.env.POSTGRES_URL_NON_POOLING;
    return { memories: [], knowledge: [], contextText: "", retrieval: {
      status: disabled ? "disabled" : "degraded", memoryCount: 0, knowledgeChunkCount: 0, maxChars,
      memoryIds: [], chunkIds: [], chars: 0,
    } };
  }
}

async function activateBrainFeedbackOnIngestion(
  row: Record<string, unknown>,
  sourceProduct: string,
  duplicate: boolean,
): Promise<Record<string, unknown> & { id: string; duplicate: boolean }> {
  const id = typeof row.id === "string" ? row.id : "";
  if (!safeUuid(id)) throw new Error("Feedback record could not be activated because its ID was invalid.");
  const status = typeof row.status === "string" ? row.status : "draft";
  if (status === "approved") return { ...row, id, duplicate, activated: true };
  // Never override a deliberate rejection/archive by replaying the same idempotent ingestion.
  if (status !== "draft") return { ...row, id, duplicate, activated: false };

  const activation = await reviewBrainFeedback({
    feedbackId: id,
    action: "approve",
    expectedSourceProduct: sourceProduct,
    reviewNote: "Automatically activated after relevance and scope checks; eligible ingestion does not require manual approval.",
  });
  return {
    ...row,
    id,
    status: "approved",
    duplicate,
    activated: true,
    activation,
  };
}

export async function saveBrainFeedback(input: BrainFeedbackInput): Promise<Record<string, unknown> & { id: string; duplicate: boolean }> {
  const rawFeedback = textValue(input.rawFeedback, 12000, "rawFeedback", true);
  const title = textValue(input.title, 180, "title", true);
  const normalizedRule = textValue(input.normalizedRule, 2400, "normalizedRule", true);
  const sourceProduct = normalizeSource(input.sourceProduct);
  const scopeKey = normalizeScope(input.scopeKey);
  const feedbackKind = textValue(input.feedbackKind, 48, "feedbackKind") || "general";
  if (!FEEDBACK_KINDS.has(feedbackKind)) throw new Error("Unsupported feedbackKind.");
  const summary = textValue(input.summary, 1200, "summary") || rawFeedback.slice(0, 500);
  const rationale = textValue(input.rationale, 1800, "rationale");
  const keywords = normalizeTags(input.keywords);
  const relevance = assessBrainRelevance(title, [rawFeedback, normalizedRule, rationale, summary, keywords.join(" ")].join("\n"), scopeKey);
  if (!relevance.eligible) {
    throw new Error("Feedback relevance scored " + Math.round(relevance.score * 100) + "%, below the 50% ingestion threshold. Add reusable UX/product context or correct its project scope; nothing was stored.");
  }
  const idempotencyKey = textValue(input.idempotencyKey, 180, "idempotencyKey") || createHash("sha256").update([sourceProduct, scopeKey, title.toLowerCase(), rawFeedback, normalizedRule].join("|")).digest("hex");
  const payload = {
    source_product: sourceProduct,
    scope_key: scopeKey,
    feedback_kind: feedbackKind,
    raw_feedback: rawFeedback,
    summary,
    title,
    normalized_rule: normalizedRule,
    rationale,
    keywords,
    examples: normalizeExamples(input.examples),
    original_language: textValue(input.originalLanguage, 60, "originalLanguage") || "unknown",
    source_audit_ref: textValue(input.sourceAuditRef, 120, "sourceAuditRef") || null,
    source_finding_title: textValue(input.sourceFindingTitle, 240, "sourceFindingTitle") || null,
    status: "draft",
    idempotency_key: idempotencyKey,
    metadata: {
      ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
      ingestion: {
        mode: "automatic",
        relevanceScore: relevance.score,
        relevanceThreshold: relevance.threshold,
        scoringMethod: relevance.method,
        generalSignals: relevance.generalSignals,
        scopeSignals: relevance.scopeSignals,
        requiresHumanApproval: false,
      },
    },
    updated_at: new Date().toISOString(),
  };
  const existingPath = `uxd_brain_feedback?select=id,status,title,scope_key,source_product,created_at&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`;
  const existingBeforeWrite = await supabaseRequest(existingPath);
  const existingRow = Array.isArray(existingBeforeWrite) ? existingBeforeWrite[0] : null;
  if (existingRow && typeof existingRow.id === "string") {
    return activateBrainFeedbackOnIngestion(existingRow as Record<string, unknown>, sourceProduct, true);
  }
  try {
    const created = await supabaseRequest("uxd_brain_feedback", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    const row = Array.isArray(created) ? created[0] : created && typeof created === "object" ? created as Record<string, unknown> : null;
    if (row && typeof row.id === "string") {
      return activateBrainFeedbackOnIngestion(row as Record<string, unknown>, sourceProduct, false);
    }
  } catch (error) {
    // A concurrent retry can win the partial unique index between our read and insert.
    const duplicate = await supabaseRequest(existingPath).catch(() => null);
    const found = Array.isArray(duplicate) ? duplicate[0] : null;
    if (found && typeof found.id === "string") {
      return activateBrainFeedbackOnIngestion(found as Record<string, unknown>, sourceProduct, true);
    }
    throw error;
  }
  throw new Error("Could not confirm whether coaching feedback was saved.");
}

export async function listBrainFeedback(input: { status?: string; sourceProduct?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
  const validStatuses = new Set(["draft", "approved", "rejected", "archived"]);
  const parts = ["select=id,created_at,updated_at,source_product,scope_key,feedback_kind,raw_feedback,summary,title,normalized_rule,rationale,keywords,examples,original_language,source_audit_ref,source_finding_title,memory_item_id,status,review_note,reviewed_at,metadata", "order=updated_at.desc", `limit=${limit}`];
  if (input.status && input.status !== "all") {
    if (!validStatuses.has(input.status)) throw new Error("Unsupported feedback status.");
    parts.push("status=eq." + encodeURIComponent(input.status));
  }
  if (input.sourceProduct) parts.push("source_product=eq." + encodeURIComponent(normalizeSource(input.sourceProduct)));
  const result = await supabaseRequest("uxd_brain_feedback?" + parts.join("&"));
  return Array.isArray(result) ? result as Record<string, unknown>[] : [];
}

export async function reviewBrainFeedback(input: { feedbackId: string; action: "approve" | "reject" | "archive"; reviewNote?: string; expectedSourceProduct?: string }) {
  if (!safeUuid(input.feedbackId)) throw new Error("feedbackId must be a valid UUID.");
  if (input.expectedSourceProduct) {
    const sourceProduct = normalizeSource(input.expectedSourceProduct);
    const existing = await supabaseRequest(`uxd_brain_feedback?select=id,source_product&id=eq.${encodeURIComponent(input.feedbackId)}&source_product=eq.${encodeURIComponent(sourceProduct)}&limit=1`);
    if (!Array.isArray(existing) || !existing[0]?.id) {
      throw new Error("The feedback record does not belong to the specified source product.");
    }
  }
  const result = await supabaseRequest("rpc/uxd_brain_review_feedback", {
    method: "POST",
    body: JSON.stringify({
      p_feedback_id: input.feedbackId,
      p_action: input.action,
      p_review_note: textValue(input.reviewNote, 1000, "reviewNote"),
    }),
  });
  return result as Record<string, unknown>;
}

function splitText(text: string, maxChars = 1100, overlap = 140): string[] {
  const content = text.trim();
  if (!content) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length && chunks.length < 120) {
    const hardEnd = Math.min(content.length, start + maxChars);
    let end = hardEnd;
    if (hardEnd < content.length) {
      const paragraph = content.lastIndexOf("\n\n", hardEnd);
      const space = content.lastIndexOf(" ", hardEnd);
      const ideal = paragraph > start + Math.floor(maxChars * 0.45) ? paragraph : space;
      if (ideal > start + Math.floor(maxChars * 0.45)) end = ideal;
    }
    const chunk = content.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= content.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export async function addBrainKnowledgeDocument(input: {
  title: string;
  content: string;
  projectKey?: string;
  sourceUrl?: string;
  sourceType?: string;
  sourceAuthority?: string;
  status?: "draft" | "approved";
  metadata?: Record<string, unknown>;
  sourceProduct?: string;
}) {
  const title = textValue(input.title, 240, "title", true);
  const content = textValue(input.content, 100000, "content", true);
  const projectKey = normalizeScope(input.projectKey);
  const sourceType = textValue(input.sourceType, 60, "sourceType") || "document";
  const sourceAuthority = textValue(input.sourceAuthority, 60, "sourceAuthority") || "internal";
  const sourceUrl = textValue(input.sourceUrl, 1800, "sourceUrl") || null;
  const sourceProduct = normalizeSource(input.sourceProduct || "knowledge-ingestion");
  const relevance = assessBrainRelevance(title, content, projectKey);
  if (!relevance.eligible) {
    throw new Error("Knowledge relevance scored " + Math.round(relevance.score * 100) + "%, below the 50% ingestion threshold. Nothing was stored; add relevant UX/product signals or correct the document scope.");
  }
  const documentMetadata = {
    ...(input.metadata || {}),
    sourceProduct,
    contentHash: createHash("sha256").update(content).digest("hex"),
    ingestion: {
      mode: "automatic",
      relevanceScore: relevance.score,
      relevanceThreshold: relevance.threshold,
      scoringMethod: relevance.method,
      generalSignals: relevance.generalSignals,
      scopeSignals: relevance.scopeSignals,
      requiresHumanApproval: false,
    },
  };
  const chunks = splitText(content);
  if (!chunks.length) throw new Error("Document content did not produce any searchable chunks.");
  const docResult = await supabaseRequest("uxd_knowledge_documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      project_key: projectKey,
      title,
      source_url: sourceUrl,
      source_type: sourceType,
      source_authority: sourceAuthority,
      status: "draft",
      last_verified_at: null,
      metadata: documentMetadata,
      updated_at: new Date().toISOString(),
    }),
  });
  const document = Array.isArray(docResult) ? docResult[0] : null;
  if (!document?.id) throw new Error("The shared brain did not return a knowledge document ID.");
  try {
    const chunkRows = chunks.map((chunk, chunkIndex) => ({
      document_id: document.id,
      project_key: projectKey,
      chunk_index: chunkIndex,
      content: chunk,
      content_hash: createHash("sha256").update(chunk).digest("hex"),
      metadata: {
        title,
        sourceUrl,
        sourceType,
        sourceAuthority,
        scopeKey: projectKey,
        chunkCount: chunks.length,
      },
    }));
    await supabaseRequest("uxd_knowledge_chunks", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(chunkRows),
    });
    const now = new Date().toISOString();
    const activation = await supabaseRequest(`uxd_knowledge_documents?id=eq.${encodeURIComponent(document.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "approved", updated_at: now }),
    });
    const activeDocument = Array.isArray(activation) ? activation[0] : null;
    if (!activeDocument?.id || activeDocument.status !== "approved") {
      throw new Error("The knowledge document chunks were stored, but automatic activation could not be confirmed.");
    }
  } catch (error) {
    await supabaseRequest(`uxd_knowledge_documents?id=eq.${encodeURIComponent(document.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "failed", metadata: { ...documentMetadata, ingestionError: error instanceof Error ? error.message.slice(0, 300) : "chunk write failed" }, updated_at: new Date().toISOString() }),
    }).catch(() => {});
    throw error;
  }
  return { id: document.id as string, title, projectKey, sourceUrl, chunkCount: chunks.length, status: "approved" as const, active: true, relevanceScore: relevance.score, automaticIngestion: true };
}

export async function reviewBrainKnowledgeDocument(input: { documentId: string; action: "approve" | "reject" | "archive" }) {
  if (!safeUuid(input.documentId)) throw new Error("documentId must be a valid UUID.");
  const status = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "archived";
  const now = new Date().toISOString();
  const result = await supabaseRequest(`uxd_knowledge_documents?id=eq.${encodeURIComponent(input.documentId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      status,
      updated_at: now,
      last_verified_at: input.action === "approve" ? now.slice(0, 10) : null,
    }),
  });
  const row = Array.isArray(result) ? result[0] : null;
  if (!row?.id) throw new Error("Knowledge document was not found or could not be updated.");
  return { id: row.id, title: row.title, projectKey: row.project_key, status: row.status };
}

export async function listBrainKnowledgeDocuments(input: { status?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
  const validStatuses = new Set(["draft", "approved", "rejected", "archived", "failed"]);
  const parts = ["select=id,created_at,updated_at,project_key,title,source_url,source_type,source_authority,published_at,effective_at,last_verified_at,version_label,status,metadata", "order=updated_at.desc", `limit=${limit}`];
  if (input.status && input.status !== "all") {
    if (!validStatuses.has(input.status)) throw new Error("Unsupported document status.");
    parts.push("status=eq." + encodeURIComponent(input.status));
  }
  const result = await supabaseRequest("uxd_knowledge_documents?" + parts.join("&"));
  return Array.isArray(result) ? result as Record<string, unknown>[] : [];
}

export async function saveBrainEvalCase(input: {
  scopeKey?: string;
  capability?: string;
  title: string;
  input: string;
  expectedBehavior: string;
  forbiddenBehaviors?: string[];
  expectedMemoryIds?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const scopeKey = normalizeScope(input.scopeKey);
  const forbiddenBehaviors = (input.forbiddenBehaviors || []).map(value => textValue(value, 300, "forbiddenBehavior")).filter(Boolean).slice(0, 20);
  const expectedMemoryIds = (input.expectedMemoryIds || []).filter(safeUuid).slice(0, 30);
  const body = {
    scope_key: scopeKey,
    capability: textValue(input.capability, 100, "capability") || "retrieval",
    title: textValue(input.title, 200, "title", true),
    input: textValue(input.input, 4000, "input", true),
    expected_behavior: textValue(input.expectedBehavior, 2000, "expectedBehavior", true),
    forbidden_behaviors: forbiddenBehaviors,
    expected_memory_ids: expectedMemoryIds,
    status: "draft",
    source: textValue(input.source, 80, "source") || "human-approved",
    metadata: input.metadata || {},
    updated_at: new Date().toISOString(),
  };
  const result = await supabaseRequest("uxd_brain_eval_cases", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  const row = Array.isArray(result) ? result[0] : null;
  if (!row?.id) throw new Error("Could not save the shared-brain evaluation case.");
  return { id: row.id, title: row.title, scopeKey: row.scope_key, capability: row.capability, status: row.status };
}

export async function reviewBrainEvalCase(input: { caseId: string; action: "approve" | "reject" | "archive" }) {
  if (!safeUuid(input.caseId)) throw new Error("caseId must be a valid UUID.");
  const status = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "archived";
  const result = await supabaseRequest(`uxd_brain_eval_cases?id=eq.${encodeURIComponent(input.caseId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  const row = Array.isArray(result) ? result[0] : null;
  if (!row?.id) throw new Error("Evaluation case was not found or could not be reviewed.");
  return { id: row.id, title: row.title, scopeKey: row.scope_key, status: row.status };
}

export async function listBrainEvalCases(limit = 100) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await supabaseRequest(`uxd_brain_eval_cases?select=id,scope_key,capability,title,input,expected_behavior,forbidden_behaviors,expected_memory_ids,status,last_run_at,last_run_result,source,metadata&status=eq.approved&order=updated_at.desc&limit=${safeLimit}`);
  return Array.isArray(result) ? result as Record<string, unknown>[] : [];
}

export async function runBrainRetrievalEvals(limit = 50) {
  const cases = await listBrainEvalCases(limit);
  const results = [];
  for (const item of cases) {
    const caseScope = String(item.scope_key || "UX_SHARED_BRAIN");
    const evaluationScopes = caseScope === "UX_SHARED_BRAIN" ? ["UX_SHARED_BRAIN"] : ["UX_SHARED_BRAIN", caseScope];
    const retrieval = await retrieveBrainContext({ query: String(item.input || ""), scopeKeys: evaluationScopes, limit: 8, includeKnowledge: true, maxChars: 5200 });
    const expected = Array.isArray(item.expected_memory_ids) ? item.expected_memory_ids.map(String) : [];
    const retrievedIds = retrieval.memories.map(memory => memory.id);
    const missingExpected = expected.filter(id => !retrievedIds.includes(id));
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
    const expectedDocumentIds = Array.isArray(metadata.expectedDocumentIds) ? metadata.expectedDocumentIds.filter((value): value is string => typeof value === "string") : [];
    const retrievedDocumentIds = [...new Set(retrieval.knowledge.map(chunk => chunk.document_id))];
    const missingExpectedDocuments = expectedDocumentIds.filter(id => !retrievedDocumentIds.includes(id));
    const forbidden = Array.isArray(item.forbidden_behaviors) ? item.forbidden_behaviors.filter((phrase): phrase is string => typeof phrase === "string") : [];
    const contextLower = retrieval.contextText.toLowerCase();
    const forbiddenMatches = forbidden.filter(phrase => contextLower.includes(phrase.toLowerCase()));
    const expectedTotal = expected.length + expectedDocumentIds.length;
    const missingTotal = missingExpected.length + missingExpectedDocuments.length;
    const recall = expectedTotal ? (expectedTotal - missingTotal) / expectedTotal : null;
    const passed = missingTotal === 0 && forbiddenMatches.length === 0;
    const summary = {
      caseId: item.id,
      title: item.title,
      passed,
      expectedMemoryCount: expected.length,
      retrievedMemoryCount: retrievedIds.length,
      missingExpectedMemories: missingExpected,
      expectedDocumentCount: expectedDocumentIds.length,
      retrievedDocumentIds,
      missingExpectedDocuments,
      forbiddenMatches,
      recallAtK: recall,
      retrievalStatus: retrieval.retrieval.status,
    };
    results.push(summary);
    await supabaseRequest(`uxd_brain_eval_cases?id=eq.${encodeURIComponent(String(item.id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_run_at: new Date().toISOString(), last_run_result: summary, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }
  return {
    total: results.length,
    passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length,
    results,
  };
}
