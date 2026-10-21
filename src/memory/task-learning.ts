import { createHash } from "node:crypto";
import { assessBrainRelevance, resolveLearningScope } from "./learning-signal";
import { neonRequest } from "./neon-rest";
import { saveBrainFeedback } from "./shared-brain";
import type { TaskProject } from "@/src/core/types";
import { containsSensitiveMaterial, referencesUnstatedClient, sanitizeInlineLearningCandidate, type InlineLearningCandidate } from "./inline-learning";

export type FigmaFailureCategory =
  | "file-scope"
  | "stale-node-id"
  | "timeout-or-expired"
  | "unsupported-api"
  | "invalid-payload";

export type FigmaFailureLesson = {
  category: FigmaFailureCategory;
  title: string;
  rawFeedback: string;
  normalizedRule: string;
  rationale: string;
  keywords: string[];
  idempotencyKey: string;
};

/**
 * Convert a verified native-plugin failure into a small reusable recovery rule.
 * Never return/store the raw error text because it may contain client or canvas data.
 */
export function buildFigmaFailureLesson(errorMessage: string): FigmaFailureLesson | null {
  const value = String(errorMessage || "").toLowerCase();
  let category: FigmaFailureCategory | null = null;

  if (/\b(allowlist|allowlisted|file[- ]key|approved file|permission|not authorized)\b/.test(value)) {
    category = "file-scope";
  } else if (/\b(invalid payload|payload is invalid|validation|schema|requires .{1,50}|required field|must be provided)\b/.test(value)) {
    category = "invalid-payload";
  } else if (/\b(node.{0,30}(not found|unknown|missing)|unknown node|invalid node.?id|node id.{0,30}(not found|invalid|stale))\b/.test(value)) {
    category = "stale-node-id";
  } else if (/\b(expired|timed out|timeout|no longer active|stopped responding|offline)\b/.test(value)) {
    category = "timeout-or-expired";
  } else if (/\b(unsupported|not supported|is not a function|api.{0,20}(missing|unavailable))\b/.test(value)) {
    category = "unsupported-api";
  }

  if (!category) return null;

  const rules: Record<FigmaFailureCategory, { label: string; rule: string; keywords: string[] }> = {
    "file-scope": {
      label: "file scope or permission check",
      rule: "When a Figma command fails a file-scope or permission check, verify the active file key and approved plugin session before retrying. Never bypass the file allowlist or replay writes into another file.",
      keywords: ["figma", "plugin", "file-scope", "permissions", "security"],
    },
    "stale-node-id": {
      label: "stale or unknown node ID",
      rule: "Before editing, cloning, reparenting, or styling a Figma node, refresh the active page or selection and verify the node ID. If it still fails, re-read the current canvas state rather than repeatedly retrying a stale ID.",
      keywords: ["figma", "plugin", "canvas", "node-id", "recovery"],
    },
    "timeout-or-expired": {
      label: "timed-out or expired command",
      rule: "When a Figma canvas command times out or expires, check its command status and re-read the current canvas before retrying. A write batch may partially complete, so do not blindly replay non-idempotent operations.",
      keywords: ["figma", "plugin", "execution", "timeout", "command-status", "recovery"],
    },
    "unsupported-api": {
      label: "unsupported native API operation",
      rule: "Before retrying a failed Figma operation, verify native Plugin API support and the installed UX Direct bridge version. Report unsupported capabilities explicitly instead of assuming a write succeeded.",
      keywords: ["figma", "plugin", "native-api", "execution", "recovery"],
    },
    "invalid-payload": {
      label: "invalid command payload",
      rule: "When a Figma command payload fails validation, correct its schema and required fields before retrying. Do not repeatedly submit the same invalid payload, and verify command status after any retry.",
      keywords: ["figma", "plugin", "payload", "validation", "execution"],
    },
  };

  const selected = rules[category];
  return {
    category,
    title: "Figma execution recovery · " + category,
    rawFeedback: "Sanitized task learning from a verified Figma plugin failure category: " + category + ". Raw error text, node IDs, screen text, and canvas data were not copied into the shared brain.",
    normalizedRule: selected.rule,
    rationale: "Derived from the outcome of a native Figma canvas command. Only a normalized recovery principle and the coarse failure category are retained; the raw error and design content are excluded.",
    keywords: selected.keywords,
    idempotencyKey: "uxd-figma-recovery-" + category,
  };
}


export type AutomaticFigmaLearningStatus = "not-extracted" | "filtered" | "active" | "inactive" | "failed";

/**
 * Persist a validated reusable lesson extracted during an existing Figma inference.
 * Raw prompts, canvas text/nodes, screenshots and review evidence are not stored.
 */
export async function captureFigmaTaskLearning(
  value: unknown,
  taskContext: string,
  captureMode: "automatic-figma-generation" | "automatic-figma-visual-review",
): Promise<AutomaticFigmaLearningStatus> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).activate !== true) return "not-extracted";

  const candidate: InlineLearningCandidate | null = sanitizeInlineLearningCandidate(value);
  if (!candidate || referencesUnstatedClient(candidate, taskContext)) return "filtered";
  const scopeKey = resolveLearningScope(candidate.scopeKey, "general", taskContext);
  const rule = candidate.normalizedRule.trim();
  if (!rule) return "filtered";

  try {
    const sourceProduct = "figma-plugin";
    const idempotencyKey = "uxd-inline-task-learning-" + createHash("sha256")
      .update([sourceProduct, scopeKey, rule.toLowerCase()].join("|"))
      .digest("hex");
    const saved = await saveBrainFeedback({
      rawFeedback: "Task-derived reusable lesson: " + rule,
      summary: rule.slice(0, 500),
      title: candidate.title,
      normalizedRule: rule,
      rationale: "Reusable lesson abstracted from Figma task execution or visual QA. Raw design prompt, canvas content, screenshots and evidence are not persisted.",
      scopeKey,
      feedbackKind: candidate.feedbackKind,
      keywords: candidate.keywords,
      examples: [],
      originalLanguage: candidate.originalLanguage,
      sourceProduct,
      idempotencyKey,
      metadata: {
        captureMode,
        rawTaskContextPersisted: false,
        rawCanvasContentPersisted: false,
        rawScreenshotPersisted: false,
        requiresOwnerApproval: false,
        automaticActivation: true,
        inferenceCalls: 0,
      },
    });
    return saved.activated === true ? "active" : "inactive";
  } catch (error) {
    if (error instanceof Error && /below the 50% ingestion threshold/i.test(error.message)) return "filtered";
    return "failed";
  }
}

export type VerifiedTaskRun = {
  id: string;
  outcome: "attempted" | "succeeded" | "verified" | "failed";
  project: FigmaTaskProject;
  taskContext: string;
  candidate?: unknown;
  failureMessage?: string;
  durationMs?: number;
  retrieval?: { status: string; memoryIds: string[]; chunkIds: string[]; chars: number };
};

export type FigmaTaskProject = TaskProject | "ux-direct" | "ux-audit" | "ujjivan-sfb" | "indian-bfsi";

export function resolveFigmaTaskProject(context: string): FigmaTaskProject {
  if (/\b(dmi|dmi hfc|dmi finance|dmi wealth)\b/i.test(context)) return "dmi-finance";
  if (/\bujjivan(?: sfb| small finance bank)?\b/i.test(context)) return "ujjivan-sfb";
  if (/\bexpress computers\b/i.test(context)) return "express-computers";
  if (/\b(audit|benchmark|past findings|accessibility review)\b/i.test(context)) return "ux-audit";
  if (/\b(figma|plugin|mcp|orchestration|shared brain|knowledge base|ux direct)\b/i.test(context)) return "ux-direct";
  if (/\b(indian|india|bfsi|banking|finance|financial|insurance|nbfc|rbi|loan|lending)\b/i.test(context)) return "indian-bfsi";
  return "general";
}

export function resolveFigmaTaskScope(project: FigmaTaskProject, context: string): string {
  const projectScopes: Record<FigmaTaskProject, string> = {
    general: "project:general-ux", "ux-direct": "project:ux-direct", "ux-audit": "project:ux-audit",
    "dmi-finance": "project:dmi-finance", "ujjivan-sfb": "project:ujjivan-sfb",
    "express-computers": "project:express-computers", "indian-bfsi": "indian-bfsi",
  };
  const coreProject: TaskProject = project === "dmi-finance" || project === "express-computers" ? project : "general";
  const scope = resolveLearningScope(projectScopes[project], coreProject, context);
  return scope === "UX_SHARED_BRAIN" ? "project:general-ux" : scope;
}

export type VerifiedTaskLesson = {
  memoryType: "approved_pattern" | "failure_pattern";
  title: string;
  content: string;
  tags: string[];
  scope: string;
};

const containsNodeId = (value: string) => /\b(?:[0-9]{1,12}:[0-9]{1,12}|[0-9a-f]{8}-[0-9a-f-]{27,})\b/i.test(value);

export function taskLessonDedupeKey(lesson: Pick<VerifiedTaskLesson, "scope" | "title">): string {
  return createHash("md5").update(lesson.scope + lesson.title.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

export function buildVerifiedTaskLesson(run: VerifiedTaskRun): VerifiedTaskLesson | null {
  if (run.outcome !== "verified" && run.outcome !== "failed") return null;
  const taskContext = String(run.taskContext || "").slice(0, 5000);
  const safeScope = resolveFigmaTaskScope(run.project, taskContext);
  let candidate: InlineLearningCandidate | null = null;
  let memoryType: VerifiedTaskLesson["memoryType"];
  if (run.outcome === "failed") {
    const failure = buildFigmaFailureLesson(String(run.failureMessage || ""));
    if (!failure) return null;
    candidate = {
      title: failure.title, normalizedRule: failure.normalizedRule, rationale: failure.rationale,
      scopeKey: safeScope, feedbackKind: "other", keywords: failure.keywords, originalLanguage: "English",
    };
    memoryType = "failure_pattern";
  } else {
    candidate = sanitizeInlineLearningCandidate(run.candidate);
    if (!candidate) return null;
    candidate = { ...candidate, scopeKey: safeScope };
    memoryType = "approved_pattern";
  }
  const content = [candidate.title, candidate.normalizedRule, candidate.rationale].join("\n").trim();
  if (content.length > 600 || containsSensitiveMaterial(content) || containsNodeId(content) || referencesUnstatedClient(candidate, taskContext)) return null;
  const relevance = assessBrainRelevance(candidate.title, content, safeScope);
  if (!relevance.eligible || relevance.score < 0.5) return null;
  return { memoryType, title: candidate.title, content, tags: [...new Set(candidate.keywords)].sort().slice(0, 20), scope: safeScope };
}

/** Capture only lessons supported by a verified result or a categorized execution failure. */
export async function captureVerifiedTaskLesson(run: VerifiedTaskRun): Promise<{
  status: "stored" | "deduplicated" | "filtered" | "not-eligible" | "failed";
  memoryId?: string;
  lesson?: VerifiedTaskLesson;
}> {
  const lesson = buildVerifiedTaskLesson(run);
  if (!lesson) return { status: run.outcome === "verified" || run.outcome === "failed" ? "filtered" : "not-eligible" };
  const dedupeKey = taskLessonDedupeKey(lesson);
  try {
    const claimed = await neonRequest("rpc/uxd_task_claim_lesson", {
      method: "POST", body: JSON.stringify({ p_task_run_id: run.id }),
    });
    if (claimed !== true) return { status: "not-eligible", lesson };
    const saved = await neonRequest("rpc/uxd_brain_capture_task_lesson", {
      method: "POST",
      body: JSON.stringify({
        p_scope: lesson.scope, p_memory_type: lesson.memoryType, p_title: lesson.title,
        p_content: lesson.content, p_tags: lesson.tags, p_dedupe_key: dedupeKey,
      }),
    }) as Record<string, unknown> | null;
    const memoryId = saved && typeof saved.memory_id === "string" ? saved.memory_id : undefined;
    const deduplicated = saved?.deduplicated === true;
    try { await neonRequest("uxd_model_learning_events", {
      method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        request_id: run.id, capability: "figma-task-learning", model_id: "deterministic-task-outcome",
        model_tier: "free-tier", outcome: run.outcome === "verified" ? "validated" : "validation_failure",
        validation_passed: run.outcome === "verified", latency_ms: Math.max(0, Math.floor(run.durationMs || 0)),
        error_category: lesson.memoryType === "failure_pattern" ? lesson.tags.find(tag => ["file-scope", "stale-node-id", "timeout", "unsupported-api", "invalid-payload"].includes(tag)) || null : null,
        operation_profile: { scope: lesson.scope, memoryType: lesson.memoryType, deduplicated, retrievalStatus: run.retrieval?.status || "unknown" },
      }),
    }); } catch (error) {
      console.warn("[uxd-task-learning] event logging failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown");
    }
    return { status: deduplicated ? "deduplicated" : "stored", ...(memoryId ? { memoryId } : {}), lesson };
  } catch (error) {
    try { await neonRequest("uxd_task_runs?id=eq." + encodeURIComponent(run.id), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ lesson: null }),
    }); } catch { /* Keep capture failure non-blocking; run completion is logged separately. */ }
    console.warn("[uxd-task-learning] capture failed:", error instanceof Error ? error.message.slice(0, 180) : "unknown");
    return { status: "failed", lesson };
  }
}
