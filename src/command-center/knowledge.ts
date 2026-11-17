import { listBrainFeedback, listBrainKnowledgeDocuments } from "@/src/memory/shared-brain";

/** A draft waiting for a decision, with everything a reviewer needs to make one. */
export type PendingRule = KnowledgeRule & {
  rationale: string;
  evidence: string;
  keywords: string[];
  /** Where it came from: a measurement, a model, or a person. Written by the product that saved it. */
  provenance: string;
  auditRef: string;
  findingTitle: string;
  createdAt: string;
};

export type KnowledgeRule = {
  id: string;
  title: string;
  rule: string;
  scope: string;
  kind: string;
  source: string;
  status: string;
  updatedAt: string;
};

export type KnowledgeDocument = {
  id: string;
  title: string;
  projectKey: string;
  sourceType: string;
  status: string;
  updatedAt: string;
};

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function normalizeRule(row: Record<string, unknown>): KnowledgeRule {
  return {
    id: text(row.id, 64),
    title: text(row.title, 200) || "Untitled rule",
    // Only the distilled rule is shown; raw owner feedback stays in the database.
    rule: text(row.normalized_rule, 1200) || text(row.summary, 600),
    scope: text(row.scope_key, 100),
    kind: text(row.feedback_kind, 60),
    source: text(row.source_product, 60),
    status: text(row.status, 30),
    updatedAt: text(row.updated_at, 40),
  };
}

export function normalizeDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: text(row.id, 64),
    title: text(row.title, 240) || "Untitled document",
    projectKey: text(row.project_key, 100),
    sourceType: text(row.source_type, 60),
    status: text(row.status, 30),
    updatedAt: text(row.updated_at, 40),
  };
}

/** Active shared-brain rules and reference documents for the knowledge view. */
export async function loadSharedKnowledge(limit = 100): Promise<{ rules: KnowledgeRule[]; documents: KnowledgeDocument[] }> {
  const [rules, documents] = await Promise.all([
    listBrainFeedback({ status: "approved", limit }),
    listBrainKnowledgeDocuments({ status: "approved", limit }),
  ]);
  // Knowledge-base entries (version_label "kb-entry") have their own page section.
  return { rules: rules.map(normalizeRule), documents: documents.filter((row) => row.version_label !== "kb-entry").map(normalizeDocument) };
}

/** A draft, with its reasoning, so a decision is not made on the title alone. */
function normalizePending(row: Record<string, unknown>): PendingRule {
  const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  return {
    ...normalizeRule(row),
    rationale: text(row.rationale, 1800),
    // The raw note is what the product actually saw. It is the evidence behind the rule.
    evidence: text(row.raw_feedback, 2000) || text(row.summary, 800),
    keywords: Array.isArray(row.keywords) ? (row.keywords as unknown[]).map((k) => text(k, 40)).filter(Boolean).slice(0, 12) : [],
    provenance: text(meta.provenance, 24),
    auditRef: text(row.source_audit_ref, 180),
    findingTitle: text(row.source_finding_title, 240),
    createdAt: text(row.created_at, 40),
  };
}

/** Everything A11y Studio has had approved into the brain: its own branch of the knowledge base. */
export async function loadStudioKnowledge(limit = 100): Promise<{ rules: PendingRule[] }> {
  const rules = await listBrainFeedback({ status: "approved", sourceProduct: "ux-audit", limit });
  return { rules: rules.map(normalizePending) };
}

/** Drafts waiting for a decision. Anything that cleared the 50% relevance gate lands here first. */
export async function loadApprovalQueue(input: { sourceProduct?: string; limit?: number } = {}): Promise<{ rules: PendingRule[] }> {
  const rules = await listBrainFeedback({ status: "draft", sourceProduct: input.sourceProduct, limit: input.limit ?? 60 });
  return { rules: rules.map(normalizePending) };
}
