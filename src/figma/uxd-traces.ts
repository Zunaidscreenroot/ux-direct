import { randomUUID } from "node:crypto";
import type { UxdIrTrace } from "@/src/figma/uxd-ir";

type JsonRecord = Record<string, unknown>;

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return url && key ? { url, key } : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[depth-limited]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 120).map((entry) => safeValue(entry, depth + 1));
  if (!isRecord(value)) return undefined;

  const output: JsonRecord = {};
  for (const [key, child] of Object.entries(value).slice(0, 80)) {
    if (/previewDataUrl|base64|api.?key|authorization|password|secret|access.?token/i.test(key)) continue;
    const safe = safeValue(child, depth + 1);
    if (safe !== undefined) output[key.slice(0, 80)] = safe;
  }
  return output;
}

export type StoredUxdTrace = {
  run_id: string;
  created_at: string;
  project_key: string;
  capability: string;
  mode: "action" | "explain";
  status: string;
  intent_summary: string;
  protocol_version: number;
  stages: unknown[];
  artifacts: JsonRecord;
  total_prompt_tokens?: number | null;
  total_completion_tokens?: number | null;
  estimated_cost_usd?: number | null;
  observed_cost_usd?: number | null;
  execution_result?: JsonRecord | null;
};

export type UxdTraceStatus = "running" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";

export async function persistUxdIrTrace(
  trace: UxdIrTrace,
  metrics?: { totalPromptTokens?: number | null; totalCompletionTokens?: number | null; estimatedCostUsd?: number | null; observedCostUsd?: number | null },
): Promise<boolean> {
  const config = supabaseConfig();
  if (!config) return false;
  const artifacts = safeValue(trace.artifacts ?? {}) as JsonRecord;
  const stages = safeValue(trace.stages) as unknown[];
  // Keep every row bounded so a large selected design cannot become a storage bill.
  const serializedArtifacts = JSON.stringify(artifacts);
  const serializedStages = JSON.stringify(stages);
  const boundedArtifacts = serializedArtifacts.length <= 28000
    ? artifacts
    : { omitted: true, reason: "artifact_size_cap", serializedChars: serializedArtifacts.length };
  const boundedStages = serializedStages.length <= 10000
    ? stages
    : (Array.isArray(stages) ? stages.slice(0, 12) : []);
  const payload = {
    run_id: trace.runId || randomUUID(),
    project_key: trace.projectKey.slice(0, 80),
    capability: trace.capability.slice(0, 80),
    mode: trace.mode,
    status: trace.status,
    intent_summary: trace.intentSummary.slice(0, 600),
    protocol_version: trace.v,
    stages: boundedStages,
    artifacts: boundedArtifacts,
    total_prompt_tokens: metric(metrics?.totalPromptTokens),
    total_completion_tokens: metric(metrics?.totalCompletionTokens),
    estimated_cost_usd: metric(metrics?.estimatedCostUsd),
    observed_cost_usd: metric(metrics?.observedCostUsd),
    updated_at: new Date().toISOString(),
  };
  try {
    const response = await fetch(config.url + "/rest/v1/uxd_run_traces?on_conflict=run_id", {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: "Bearer " + config.key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(2200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function metric(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function listUxdIrTraces(projectKey: string, limit = 20): Promise<StoredUxdTrace[] | null> {
  const config = supabaseConfig();
  if (!config) return null;
  const query = new URLSearchParams({
    select: "run_id,created_at,project_key,capability,mode,status,intent_summary,protocol_version,stages,artifacts,total_prompt_tokens,total_completion_tokens,estimated_cost_usd,observed_cost_usd,execution_result",
    project_key: "eq." + projectKey.slice(0, 80),
    order: "created_at.desc",
    limit: String(Math.max(1, Math.min(50, Math.floor(limit)))),
  });
  try {
    const response = await fetch(config.url + "/rest/v1/uxd_run_traces?" + query.toString(), {
      headers: { apikey: config.key, Authorization: "Bearer " + config.key, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json().catch(() => null);
    return Array.isArray(value) ? value.filter(isRecord) as unknown as StoredUxdTrace[] : null;
  } catch {
    return null;
  }
}

export async function getUxdIrTrace(runId: string): Promise<StoredUxdTrace | null> {
  const config = supabaseConfig();
  if (!config || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) return null;
  const query = new URLSearchParams({
    select: "run_id,created_at,project_key,capability,mode,status,intent_summary,protocol_version,stages,artifacts,total_prompt_tokens,total_completion_tokens,estimated_cost_usd,observed_cost_usd,execution_result",
    run_id: "eq." + runId,
    limit: "1",
  });
  try {
    const response = await fetch(config.url + "/rest/v1/uxd_run_traces?" + query.toString(), {
      headers: { apikey: config.key, Authorization: "Bearer " + config.key, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json().catch(() => null);
    return Array.isArray(value) && value.length && isRecord(value[0]) ? value[0] as unknown as StoredUxdTrace : null;
  } catch {
    return null;
  }
}

export async function updateUxdIrTraceStatus(input: {
  runId: string;
  status: Extract<UxdTraceStatus, "completed" | "cancelled" | "failed">;
  executionResult?: JsonRecord;
}): Promise<boolean> {
  const config = supabaseConfig();
  if (!config || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.runId)) return false;
  const payload: JsonRecord = { status: input.status, updated_at: new Date().toISOString() };
  if (input.executionResult) payload.execution_result = safeValue(input.executionResult);
  try {
    const response = await fetch(config.url + "/rest/v1/uxd_run_traces?run_id=eq." + encodeURIComponent(input.runId), {
      method: "PATCH",
      headers: {
        apikey: config.key,
        Authorization: "Bearer " + config.key,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(2200),
    });
    return response.ok;
  } catch {
    return false;
  }
}
