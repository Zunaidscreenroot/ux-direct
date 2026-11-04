import { neonRequest } from "@/src/memory/neon-rest";
import { pickVerifiedExample, type VerifiedRun } from "@/src/figma-agent/spec-consistency";

/** Which upstream model produced a run, and how it fared at each attempt. */
export type GenerationRecord = {
  model: string;
  routedVia?: string;
  planFormat: "blocks" | "elements" | "none";
  designScope: string;
  qualityScore?: number;
  themeLocked?: boolean;
  repairedTexts?: number;
  attempts: Array<{ model: string; result: string }>;
};

/**
 * Stores the generated spec and model details on the task run. Kept separate from
 * finishTaskRun so a schema problem here can never block outcome logging.
 */
export async function recordGeneration(id: string, record: GenerationRecord, plan: unknown): Promise<void> {
  const metadata = {
    source: "figma-agent",
    model: record.model.slice(0, 160),
    ...(record.routedVia ? { routedVia: record.routedVia.slice(0, 160) } : {}),
    planFormat: record.planFormat,
    designScope: record.designScope,
    ...(typeof record.qualityScore === "number" ? { qualityScore: record.qualityScore } : {}),
    ...(record.themeLocked !== undefined ? { themeLocked: record.themeLocked } : {}),
    ...(record.repairedTexts ? { repairedTexts: record.repairedTexts } : {}),
    attempts: record.attempts.slice(0, 8).map((a) => ({ model: a.model.slice(0, 120), result: a.result.slice(0, 200) })),
  };
  try {
    await neonRequest("uxd_task_runs?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ metadata }),
    });
  } catch (error) {
    console.warn("[uxd-task-run] model metadata failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown");
  }
  if (plan === null || plan === undefined) return;
  const serialized = JSON.stringify(plan);
  if (serialized.length > 24000) return;
  try {
    await neonRequest("uxd_task_runs?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ plan }),
    });
  } catch (error) {
    console.warn("[uxd-task-run] plan storage failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown");
  }
}

/**
 * Structure-only example from this project's verified runs (lint passed in Figma).
 * Bounded by a short timeout: generation must not wait on the database.
 */
export async function loadVerifiedExample(projectKey: string, designScope: string, timeoutMs = 2500): Promise<string> {
  const query = "uxd_task_runs?project_key=eq." + encodeURIComponent(projectKey) +
    "&outcome=eq.verified&plan=is.not.null&select=plan,metadata&order=updated_at.desc&limit=12";
  try {
    const rows = await Promise.race([
      neonRequest(query),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!Array.isArray(rows)) return "";
    const example = pickVerifiedExample(rows as VerifiedRun[], designScope);
    const text = example ? JSON.stringify(example) : "";
    return text.length > 2600 ? "" : text;
  } catch {
    return "";
  }
}

export type ModelStats = { model: string; runs: number; verified: number; failed: number; pending: number; avgQuality: number | null; repaired: number };

/** Per-model outcome counts so models can be compared on the same quality gate. */
export function aggregateModelStats(rows: Array<{ outcome?: unknown; metadata?: unknown }>): ModelStats[] {
  const byModel = new Map<string, { runs: number; verified: number; failed: number; pending: number; quality: number[]; repaired: number }>();
  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    if (meta.source !== "figma-agent" || typeof meta.model !== "string") continue;
    const entry = byModel.get(meta.model) ?? { runs: 0, verified: 0, failed: 0, pending: 0, quality: [], repaired: 0 };
    entry.runs += 1;
    if (row.outcome === "verified") entry.verified += 1;
    else if (row.outcome === "failed") entry.failed += 1;
    else entry.pending += 1;
    if (typeof meta.qualityScore === "number") entry.quality.push(meta.qualityScore);
    if (typeof meta.repairedTexts === "number" && meta.repairedTexts > 0) entry.repaired += 1;
    byModel.set(meta.model, entry);
  }
  return [...byModel.entries()].map(([model, e]) => ({
    model, runs: e.runs, verified: e.verified, failed: e.failed, pending: e.pending, repaired: e.repaired,
    avgQuality: e.quality.length ? Math.round(e.quality.reduce((a, b) => a + b, 0) / e.quality.length) : null,
  })).sort((a, b) => b.runs - a.runs);
}
