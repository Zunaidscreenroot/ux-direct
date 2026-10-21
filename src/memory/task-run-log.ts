import { randomUUID } from "node:crypto";
import { neonRequest } from "./neon-rest";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export type RetrievalRecord = {
  status: "complete" | "empty" | "degraded" | "disabled";
  memoryIds: string[];
  chunkIds: string[];
  chars: number;
};
export type TaskOutcome = "attempted" | "succeeded" | "verified" | "failed";

export function deferTaskWork(work: Promise<unknown>): void {
  const settled = work.catch(error => console.warn("[uxd-task-run] background work failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown"));
  try { getCloudflareContext().ctx.waitUntil(settled); }
  catch { void settled; }
}

function safeSummary(value: string): string {
  return value.trim().replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{1,12}:\d{1,12})\b/gi, "[id]")
    .replace(/\s+/g, " ").slice(0, 1900);
}

export async function startTaskRun(input: {
  id?: string;
  projectKey: string;
  title: string;
  requestSummary: string;
  retrieval: RetrievalRecord;
}): Promise<string> {
  const id = input.id || randomUUID();
  try {
    await neonRequest("uxd_task_runs?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({
      id, project_key: input.projectKey, title: safeSummary(input.title).slice(0, 240),
      request_summary: safeSummary(input.requestSummary), status: "running", outcome: "attempted",
      retrieval: input.retrieval, metadata: { source: "figma-agent" },
    }) });
  } catch (error) {
    console.warn("[uxd-task-run] start failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown");
  }
  return id;
}

export async function finishTaskRun(input: {
  id: string;
  outcome: TaskOutcome;
  durationMs: number;
  retrieval?: RetrievalRecord;
  lesson?: Record<string, unknown> | null;
  summary?: string;
  errorSummary?: string;
}): Promise<void> {
  try {
    await neonRequest("uxd_task_runs?id=eq." + encodeURIComponent(input.id), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        outcome: input.outcome,
        status: input.outcome === "failed" ? "failed" : input.outcome === "attempted" ? "running" : "completed",
        duration_ms: Math.max(0, Math.floor(input.durationMs)),
        ...(input.retrieval ? { retrieval: input.retrieval } : {}),
        ...(input.lesson !== undefined ? { lesson: input.lesson } : {}),
        ...(input.summary ? { outcome_summary: safeSummary(input.summary).slice(0, 3900) } : {}),
        ...(input.errorSummary ? { error_summary: safeSummary(input.errorSummary).slice(0, 1900) } : {}),
      }),
    });
  } catch (error) {
    console.warn("[uxd-task-run] finish failed:", error instanceof Error ? error.message.slice(0, 160) : "unknown");
  }
}
