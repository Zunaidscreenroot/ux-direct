import { neonRequest } from "@/src/memory/neon-rest";

export const ACTIVITY_WINDOW_DAYS = 7;

export type ActivityItem = {
  id: string;
  at: string;
  title: string;
  request: string;
  outcome: "attempted" | "succeeded" | "verified" | "failed" | "unknown";
  durationMs: number | null;
  model: string | null;
  summary: string;
  error: string;
  projectKey: string;
};

export type ActivitySummary = {
  windowDays: number;
  total: number;
  byOutcome: Record<ActivityItem["outcome"], number>;
  byDay: Array<{ day: string; count: number }>;
};

const OUTCOMES = new Set(["attempted", "succeeded", "verified", "failed"]);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function normalizeActivityRow(row: Record<string, unknown>): ActivityItem {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  const outcome = typeof row.outcome === "string" && OUTCOMES.has(row.outcome) ? row.outcome as ActivityItem["outcome"] : "unknown";
  const duration = typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) ? row.duration_ms : null;
  return {
    id: text(row.id, 64),
    at: text(row.updated_at, 40),
    title: text(row.title, 240) || "Untitled plugin task",
    request: text(row.request_summary, 600),
    outcome,
    durationMs: duration,
    model: text(metadata.model, 160) || null,
    summary: text(row.outcome_summary, 600),
    error: text(row.error_summary, 400),
    projectKey: text(row.project_key, 100),
  };
}

export function summarizeActivity(items: ActivityItem[], windowDays = ACTIVITY_WINDOW_DAYS): ActivitySummary {
  const byOutcome: ActivitySummary["byOutcome"] = { attempted: 0, succeeded: 0, verified: 0, failed: 0, unknown: 0 };
  const days = new Map<string, number>();
  for (const item of items) {
    byOutcome[item.outcome] += 1;
    const day = item.at.slice(0, 10);
    if (day) days.set(day, (days.get(day) || 0) + 1);
  }
  return {
    windowDays,
    total: items.length,
    byOutcome,
    byDay: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, count]) => ({ day, count })),
  };
}

/** Figma plugin task runs from the last `days` days, newest first. */
export async function loadRecentActivity(days = ACTIVITY_WINDOW_DAYS, limit = 200, now = Date.now()): Promise<ActivityItem[]> {
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await neonRequest(
    "uxd_task_runs?updated_at=gte." + encodeURIComponent(since) +
    "&select=id,updated_at,project_key,title,request_summary,outcome,duration_ms,outcome_summary,error_summary,metadata" +
    "&order=updated_at.desc&limit=" + Math.max(1, Math.min(500, Math.floor(limit))),
  );
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]).map(normalizeActivityRow) : [];
}

/** Compact, bounded activity log the command-center chat answers from. */
export function formatActivityForPrompt(items: ActivityItem[], maxChars = 7000): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const parts = [
      item.at.slice(0, 16).replace("T", " ") + " UTC",
      item.outcome,
      item.title,
      item.request && item.request !== item.title ? "request: " + item.request.slice(0, 220) : "",
      item.summary ? "result: " + item.summary.slice(0, 220) : "",
      item.error ? "error: " + item.error.slice(0, 160) : "",
      item.model ? "model: " + item.model : "",
    ].filter(Boolean);
    const line = "- " + parts.join(" | ");
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
