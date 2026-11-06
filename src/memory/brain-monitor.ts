import { aggregateModelStats, type ModelStats } from "./verified-specs";

/**
 * Counts-only health view of the shared brain for the improvement loop.
 * It never returns prompts, summaries, memory text, lesson text, ids or errors:
 * only outcome counts, rates and model names.
 */
export type TaskRunRow = {
  outcome?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  retrieval?: unknown;
  lesson?: unknown;
  metadata?: unknown;
  plan?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

export type BrainMonitorReport = {
  window: number;
  outcomes: Record<string, number>;
  bySource: Record<string, Record<string, number>>;
  stuckAttempted: number;
  retrieval: { byStatus: Record<string, number>; avgMemories: number | null; avgChunks: number | null; zeroMemoryRuns: number };
  learning: { byLessonStatus: Record<string, number>; lessonRate: number | null };
  examples: { verifiedWithPlan: number; sourceFallbackRuns: number };
  durationMs: { median: number | null; p90: number | null };
  models: ModelStats[];
  last24h: { runs: number; verified: number; failed: number };
  lastRunAt: string | null;
};

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] || 0) + 1; };
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
const avg = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
const toTime = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
const safeKey = (value: unknown, fallback: string) =>
  typeof value === "string" && /^[a-z_-]{1,40}$/i.test(value) ? value : fallback;

export function buildBrainMonitorReport(rows: TaskRunRow[], now = Date.now()): BrainMonitorReport {
  const outcomes: Record<string, number> = {};
  const bySource: Record<string, Record<string, number>> = {};
  const byStatus: Record<string, number> = {};
  const byLessonStatus: Record<string, number> = {};
  const memories: number[] = [];
  const chunks: number[] = [];
  const durations: number[] = [];
  let zeroMemoryRuns = 0, stuckAttempted = 0, verifiedWithPlan = 0, sourceFallbackRuns = 0, finalized = 0, withLesson = 0;
  const last24h = { runs: 0, verified: 0, failed: 0 };
  let lastRunAt = 0;

  for (const row of rows) {
    const outcome = safeKey(row.outcome, "unknown");
    bump(outcomes, outcome);
    const source = safeKey(rec(row.metadata).source, "unknown");
    bump(bySource[source] ??= {}, outcome);
    const updated = toTime(row.updated_at);
    const createdAt = toTime(row.created_at);
    const created = Number.isFinite(createdAt) ? createdAt : updated;
    if (Number.isFinite(updated)) lastRunAt = Math.max(lastRunAt, updated);
    if (outcome === "attempted" && Number.isFinite(updated) && now - updated > 30 * 60_000) stuckAttempted += 1;
    if (Number.isFinite(created) && now - created <= 24 * 3600_000) {
      last24h.runs += 1;
      if (outcome === "verified") last24h.verified += 1;
      if (outcome === "failed") last24h.failed += 1;
    }
    const retrieval = rec(row.retrieval);
    bump(byStatus, safeKey(retrieval.status, "unknown"));
    const memoryCount = Array.isArray(retrieval.memoryIds) ? retrieval.memoryIds.length : 0;
    memories.push(memoryCount);
    chunks.push(Array.isArray(retrieval.chunkIds) ? retrieval.chunkIds.length : 0);
    if (memoryCount === 0) zeroMemoryRuns += 1;
    if (outcome === "verified" || outcome === "failed") {
      finalized += 1;
      const lesson = rec(row.lesson);
      const lessonStatus = row.lesson ? safeKey(lesson.status, "unknown") : "none";
      bump(byLessonStatus, lessonStatus);
      if (lessonStatus === "stored" || lessonStatus === "deduplicated") withLesson += 1;
    }
    const meta = rec(row.metadata);
    if (meta.model === "source-fallback") sourceFallbackRuns += 1;
    if (outcome === "verified" && row.plan) verifiedWithPlan += 1;
    const duration = Number(row.duration_ms);
    if (Number.isFinite(duration) && duration > 0) durations.push(duration);
  }
  durations.sort((a, b) => a - b);
  return {
    window: rows.length,
    outcomes,
    bySource,
    stuckAttempted,
    retrieval: { byStatus, avgMemories: avg(memories), avgChunks: avg(chunks), zeroMemoryRuns },
    learning: { byLessonStatus, lessonRate: finalized ? Math.round(withLesson / finalized * 100) / 100 : null },
    examples: { verifiedWithPlan, sourceFallbackRuns },
    durationMs: { median: pct(durations, 0.5), p90: pct(durations, 0.9) },
    models: aggregateModelStats(rows),
    last24h,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
  };
}
