import { listBrainFeedback, listBrainKnowledgeDocuments } from "@/src/memory/shared-brain";

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
  return { rules: rules.map(normalizeRule), documents: documents.map(normalizeDocument) };
}
