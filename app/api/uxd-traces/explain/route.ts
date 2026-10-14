import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { resolveKnowledgeProjectKey } from "@/src/figma/knowledge-rag";
import {
  callOpenRouterChat,
  getPluginModelList,
  isAllowedPluginOrigin,
  pluginCorsHeaders,
  PluginOpenRouterError,
  reserveDailyPaidModelBudget,
  settleDailyPaidModelBudget,
} from "@/src/figma/plugin-ai-api";
import { getUxdIrTrace } from "@/src/figma/uxd-traces";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(request: Request, value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: pluginCorsHeaders(request) });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: pluginCorsHeaders(request) });
}

/** Generate human-readable trace commentary only when a user explicitly opens Explain. */
export async function POST(request: Request) {
  if (!isAllowedPluginOrigin(request)) return json(request, { error: "Origin not allowed." }, 403);
  let body: unknown;
  try { body = await request.json(); }
  catch { return json(request, { error: "Request body must be JSON." }, 400); }
  if (!isRecord(body)) return json(request, { error: "Request body must be a JSON object." }, 400);
  if (typeof body.fileKey !== "string" || !isAllowedFigmaFileKey(body.fileKey)) return json(request, { error: "Figma file is not allowlisted." }, 403);
  if (typeof body.runId !== "string") return json(request, { error: "A runId is required." }, 400);
  const requestedProject = resolveKnowledgeProjectKey(typeof body.project === "string" ? body.project : "");
  if (!requestedProject) return json(request, { error: "A valid project scope is required." }, 400);
  const trace = await getUxdIrTrace(body.runId);
  if (!trace || trace.project_key !== requestedProject) return json(request, { error: "Trace not found in the active project scope." }, 404);

  const safeTrace = {
    protocol: "UXD-IR",
    version: trace.protocol_version,
    runId: trace.run_id,
    createdAt: trace.created_at,
    project: trace.project_key,
    capability: trace.capability,
    mode: trace.mode,
    status: trace.status,
    intent: trace.intent_summary,
    stages: trace.stages,
    artifacts: trace.artifacts,
    executionResult: trace.execution_result ?? null,
    usage: {
      promptTokens: trace.total_prompt_tokens ?? null,
      completionTokens: trace.total_completion_tokens ?? null,
      estimatedCostUsd: trace.estimated_cost_usd ?? null,
      observedCostUsd: trace.observed_cost_usd ?? null,
    },
  };
  const traceText = JSON.stringify(safeTrace).slice(0, 18000);
  const messages = [
    {
      role: "system" as const,
      content: [
        "Explain this stored UX Direct run to a product designer in concise natural language.",
        "Use only the supplied UXD-IR evidence, operation plan, model/stage metadata, validation status and execution result.",
        "Do not claim access to hidden private chain-of-thought. Do not infer unsupported motives. Distinguish observations from assumptions.",
        "If status is awaiting_confirmation, clearly state that the plugin has not confirmed execution yet. If completed, summarize the recorded execution result.",
        "Mention model stages, validation outcome, token usage and estimated/observed cost when present. Do not invent missing metrics.",
      ].join("\n"),
    },
    { role: "user" as const, content: "Explain this UXD-IR run trace:\n" + traceText },
  ];
  const modelOptions = getPluginModelList().filter((model) => model.available && model.automaticRouting !== false);
  const freeModels = modelOptions.filter((model) => model.tier === "free-tier" && !model.supportsImages);
  const paidModels = modelOptions.filter((model) => model.tier === "paid" && (model.id === "deepseek/deepseek-v4.1-flash" || model.id === "anthropic/claude-haiku-5.5"));
  const candidates = [...freeModels, ...paidModels].slice(0, 3);
  if (!candidates.length) return json(request, { error: "No approved model is available to explain this trace." }, 503);

  const requestId = randomUUID();
  let lastError: unknown = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    const maxTokens = 900;
    const inputTokens = Math.ceil((messages.map((message) => message.content).join("\n").length) / 4);
    const estimate = model.tier === "free-tier" ? 0 :
      model.inputUsdPerMillion !== null && model.outputUsdPerMillion !== null
        ? Math.max(0.000001, (inputTokens * model.inputUsdPerMillion + maxTokens * model.outputUsdPerMillion) / 1_000_000)
        : null;
    if (model.tier === "paid" && (estimate === null || estimate > 0.01)) continue;
    const ledgerRequestId = requestId + ":explain:" + index;
    try {
      if (model.tier === "paid" && estimate !== null) {
        const reservation = await reserveDailyPaidModelBudget({ estimatedCostUsd: estimate, model: model.id, requestId: ledgerRequestId });
        if (!reservation.allowed) return json(request, { error: "Daily AI budget reached; the stored trace remains available without an explanation." }, 402);
      }
      const result = await callOpenRouterChat(model.id, messages, { maxTokens, temperature: 0.1, timeoutMs: 20000, reasoningEffort: "low" });
      if (model.tier === "paid" && result.observedCostUsd !== null) {
        await settleDailyPaidModelBudget({ requestId: ledgerRequestId, actualCostUsd: result.observedCostUsd });
      }
      return json(request, {
        runId: trace.run_id,
        explanation: result.content,
        model: result.model,
        usage: result.usage,
        estimatedCostUsd: estimate,
        observedCostUsd: result.observedCostUsd,
        explanationStored: false,
      });
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : "No approved model returned an explanation.";
  const status = lastError instanceof PluginOpenRouterError ? lastError.status : 502;
  return json(request, { error: message, runId: trace.run_id }, status);
}
