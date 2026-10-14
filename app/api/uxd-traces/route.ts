import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { resolveKnowledgeProjectKey } from "@/src/figma/knowledge-rag";
import { isAllowedPluginOrigin, pluginCorsHeaders } from "@/src/figma/plugin-ai-api";
import { listUxdIrTraces, updateUxdIrTraceStatus } from "@/src/figma/uxd-traces";

function json(request: Request, value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: pluginCorsHeaders(request) });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: pluginCorsHeaders(request) });
}

export async function GET(request: Request) {
  if (!isAllowedPluginOrigin(request)) return json(request, { error: "Origin not allowed." }, 403);
  const url = new URL(request.url);
  if (!isAllowedFigmaFileKey(url.searchParams.get("fileKey"))) return json(request, { error: "Figma file is not allowlisted." }, 403);
  const projectInput = url.searchParams.get("project") || "DMI";
  const projectKey = resolveKnowledgeProjectKey(projectInput);
  if (!projectKey) return json(request, { error: "Select a valid project trace scope." }, 400);
  const requestedLimit = Number(url.searchParams.get("limit") || 20);
  const traces = await listUxdIrTraces(projectKey, Number.isFinite(requestedLimit) ? requestedLimit : 20);
  if (!traces) return json(request, { error: "UXD-IR trace storage is unavailable. Apply the Supabase migration and verify server-side credentials." }, 503);
  return json(request, {
    protocol: "UXD-IR",
    protocolVersion: 1,
    projectKey,
    traceCount: traces.length,
    traces,
    note: "Artifacts contain compact visual evidence and validated operation plans, not screenshots or model-private chain-of-thought. Natural-language explanations are generated only when requested.",
  });
}

export async function POST(request: Request) {
  if (!isAllowedPluginOrigin(request)) return json(request, { error: "Origin not allowed." }, 403);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json(request, { error: "Request body must be JSON." }, 400); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return json(request, { error: "Request body must be a JSON object." }, 400);
  const record = body as Record<string, unknown>;
  if (typeof record.fileKey !== "string" || !isAllowedFigmaFileKey(record.fileKey)) return json(request, { error: "Figma file is not allowlisted." }, 403);
  if (typeof record.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(record.runId)) return json(request, { error: "A valid runId is required." }, 400);
  if (record.status !== "completed" && record.status !== "cancelled" && record.status !== "failed") {
    return json(request, { error: "Status must be completed, cancelled, or failed." }, 400);
  }
  const projectKey = resolveKnowledgeProjectKey(typeof record.project === "string" ? record.project : "DMI");
  if (!projectKey) return json(request, { error: "Select a valid project trace scope." }, 400);
  const result = await updateUxdIrTraceStatus({
    runId: record.runId,
    status: record.status,
    executionResult: {
      ...(typeof record.appliedOperations === "number" && Number.isFinite(record.appliedOperations) ? { appliedOperations: Math.max(0, Math.min(500, record.appliedOperations)) } : {}),
      ...(typeof record.failedOperations === "number" && Number.isFinite(record.failedOperations) ? { failedOperations: Math.max(0, Math.min(500, record.failedOperations)) } : {}),
    },
  });
  if (!result) return json(request, { error: "Trace update failed or the run could not be found." }, 503);
  return json(request, { accepted: true, runId: record.runId, status: record.status });
}
