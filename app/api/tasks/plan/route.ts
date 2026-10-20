import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { planUXTask } from "@/src/core/orchestrator";
import { mockProvider } from "@/src/providers/mock-provider";
import { gatewayProvider } from "@/src/providers/gateway-provider";
import { providersFromEnv } from "@/src/model-gateway";
import { getBudgetSnapshot } from "@/src/model-gateway/usage-store";
import { getGatewaySettings } from "@/src/model-gateway/control-store";
import { recordOperationalEvent } from "@/src/observability/event-log";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { checkGatewayRateLimit } from "@/src/model-gateway/rate-limit";
import { retrieveBrainContext, saveBrainFeedback } from "@/src/memory/shared-brain";
import { resolveLearningScope } from "@/src/memory/learning-signal";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(5).max(8000),
  project: z.enum(["general", "express-computers", "dmi-finance"]),
  source: z.enum(["dashboard", "figma-plugin"]).optional(),
  fileKey: z.string().max(200).optional(),
});

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://www.figma.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}
export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const headers = { ...corsHeaders(request.headers.get("origin")), "X-Request-Id": requestId };
  const origin = request.headers.get("origin");
  const selfOrigin = new URL(request.url).origin;
  if (origin && origin !== selfOrigin && !ALLOWED_ORIGINS.has(origin)) {
    recordOperationalEvent({ source: "backend", event: "Task request blocked", status: "warning", summary: "Request rejected by origin policy.", requestId });
    return NextResponse.json({ error: "Origin not allowed", requestId }, { status: 403, headers });
  }
  const clientIp = request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const taskLimit = checkGatewayRateLimit("task-plan:" + clientIp, Date.now(), 10);
  if (!taskLimit.allowed) {
    return NextResponse.json({ error: "Task planning rate limit exceeded; retry after the current minute.", requestId }, {
      status: 429, headers: { ...headers, "Retry-After": String(taskLimit.retryAfterSeconds), "X-RateLimit-Limit": String(taskLimit.limit), "X-RateLimit-Remaining": String(taskLimit.remaining) }
    });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    recordOperationalEvent({ source: "backend", event: "Task request rejected", status: "error", summary: "Malformed JSON body.", requestId, durationMs: Date.now() - startedAt });
    return NextResponse.json({ error: "Malformed JSON body", requestId }, { status: 400, headers });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    recordOperationalEvent({ source: "backend", event: "Task request rejected", status: "error", summary: "Input validation failed.", requestId, durationMs: Date.now() - startedAt });
    return NextResponse.json({ error: "Invalid task input", details: parsed.error.flatten(), requestId }, { status: 400, headers });
  }
  const isFigmaPluginOrigin = origin !== null && ["null", "https://www.figma.com", "https://figma.com"].includes(origin);
  if (isFigmaPluginOrigin && !isAllowedFigmaFileKey(parsed.data.fileKey)) {
    recordOperationalEvent({ source: "backend", event: "Task request blocked", status: "warning", summary: "Figma-originated task request did not carry the approved file key.", requestId });
    return NextResponse.json({ error: "Approved Figma file key required for Figma-originated task requests", requestId }, { status: 403, headers });
  }
  if (parsed.data.fileKey && !isAllowedFigmaFileKey(parsed.data.fileKey)) {
    recordOperationalEvent({ source: "backend", event: "Task request blocked", status: "warning", summary: "Task request rejected because its Figma file key is not allowlisted.", requestId });
    return NextResponse.json({ error: "Figma file key is not allowlisted", requestId }, { status: 403, headers });
  }
  if (parsed.data.source === "figma-plugin" && !isAllowedFigmaFileKey(parsed.data.fileKey)) {
    recordOperationalEvent({ source: "backend", event: "Task request blocked", status: "warning", summary: "Plugin task request did not carry the approved Figma file key.", requestId });
    return NextResponse.json({ error: "Approved Figma file key required for plugin-originated task requests", requestId }, { status: 403, headers });
  }
  const originalUserInput = parsed.data.request.split(/\n\nSelected Figma context \(metadata only\):/i)[0].trim().slice(0, 12000);
  const isPluginRequest = parsed.data.source === "figma-plugin";
  const taskInput = { title: parsed.data.title, request: parsed.data.request, project: parsed.data.project };
  const configuredProviders = providersFromEnv();
  const gatewaySettings = await getGatewaySettings();
  const reasoningPolicy = gatewaySettings.modules.reasoning;
  const configuredForMode = configuredProviders.some(provider => {
    if (provider.kind === "mock") return false;
    if (reasoningPolicy.mode === "local") return provider.kind === "local";
    if (reasoningPolicy.mode === "free") return provider.kind === "free-tier" || provider.models.some(model => model.endsWith(":free"));
    if (reasoningPolicy.mode === "paid") return provider.kind !== "local" && process.env.ALLOW_PAID_MODELS === "true";
    return false;
  });
  // Disabled or explicitly selected policies must reach the gateway so it can block them clearly.
  // Default free mode stays mock-only when no free/local route is connected.
  const explicitChoice = reasoningPolicy.selectedModelKey !== "auto";
  const selectedProvider = reasoningPolicy.mode === "mock" && reasoningPolicy.enabled
    ? mockProvider
    : !reasoningPolicy.enabled || reasoningPolicy.mode === "paid" || explicitChoice || configuredForMode
      ? gatewayProvider : mockProvider;
  const executionMode = selectedProvider === mockProvider ? "mock" : "gateway";
  // Every gateway-backed task may contribute one reusable lesson; mock mode performs no ingestion.
  const learningRequested = executionMode === "gateway";
  recordOperationalEvent({ source: "backend", event: "Task request received", status: "info", summary: "Task planning request accepted; prompt contents are not stored in the operational log.", requestId, project: parsed.data.project, mode: executionMode });
  try {
    let memoryContext = "";
    let memoryRetrieval: { status: string; memoryCount: number; knowledgeChunkCount: number; maxChars: number } | null = null;
    if (executionMode === "gateway") {
      const searchableText = [parsed.data.title, parsed.data.request].join(" ");
      const scopes = ["UX_SHARED_BRAIN", "project:ux-direct", "project:general-ux"];
      if (/\b(bank|banking|bfsi|finance|financial|loan|credit|upi|insurance|nbfc|ujjivan|dmi|indian)\b/i.test(searchableText)) scopes.push("indian-bfsi");
      if (parsed.data.project === "dmi-finance") scopes.push("project:dmi-finance");
      if (parsed.data.project === "express-computers") scopes.push("project:express-computers");
      const brain = await retrieveBrainContext({
        query: searchableText,
        scopeKeys: scopes,
        limit: 6,
        maxChars: 3200,
        includeKnowledge: true,
      });
      memoryContext = brain.contextText;
      memoryRetrieval = brain.retrieval;
    }
    const result = await planUXTask({ ...taskInput, requestId, provider: selectedProvider, memoryContext, learningRequested });
    let learningCapture: { status: "not-requested" | "not-extracted" | "active" | "inactive" | "filtered" | "failed"; feedbackId?: string; scopeKey?: string; duplicate?: boolean } = { status: "not-requested" };
    if (learningRequested) {
      const candidate = result.plan.learningCandidate;
      if (!candidate || candidate.activate !== true) {
        learningCapture = { status: "not-extracted" };
      } else {
        const sourceProduct = isPluginRequest ? "figma-plugin" : "ux-direct";
        try {
          const scopeKey = resolveLearningScope(candidate.scopeKey, parsed.data.project, originalUserInput + "\n" + parsed.data.title);
          const normalizedRule = candidate.normalizedRule.trim();
          // Store the generalized lesson only; never copy the raw task brief or selected canvas text into the brain.
          const rawLearning = "Task-derived reusable lesson: " + normalizedRule;
          const idempotencyKey = "uxd-task-learning-" + createHash("sha256")
            .update([sourceProduct, scopeKey, normalizedRule.toLowerCase()].join("|"))
            .digest("hex");
          const saved = await saveBrainFeedback({
            rawFeedback: rawLearning,
            summary: normalizedRule.slice(0, 500),
            title: candidate.title,
            normalizedRule,
            rationale: (candidate.rationale || "Reusable lesson extracted from the task plan.") +
              " Captured from the task-planning inference; raw task brief was not persisted in the shared brain.",
            scopeKey,
            feedbackKind: candidate.feedbackKind,
            keywords: candidate.keywords,
            examples: [],
            originalLanguage: candidate.originalLanguage,
            sourceProduct,
            idempotencyKey,
            metadata: {
              project: parsed.data.project,
              requestId,
              origin: sourceProduct,
              captureMode: "automatic-task-learning",
              rawTaskBriefPersisted: false,
              automaticActivation: true,
              requiresOwnerApproval: false,
            },
          });
          const active = saved.activated === true;
          learningCapture = {
            status: active ? "active" : "inactive",
            feedbackId: String(saved.id),
            scopeKey,
            duplicate: saved.duplicate === true,
          };
          recordOperationalEvent({
            source: sourceProduct,
            event: active ? "Shared brain task lesson activated" : "Shared brain task lesson not activated",
            status: active ? "success" : "info",
            summary: active
              ? "A reusable lesson from task planning passed relevance and scope checks and is active for future retrieval."
              : "The matching task lesson remains inactive because it was previously rejected or archived.",
            requestId,
            project: parsed.data.project,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          const filtered = /below the 50% ingestion threshold/i.test(message);
          learningCapture = { status: filtered ? "filtered" : "failed" };
          recordOperationalEvent({
            source: sourceProduct,
            event: filtered ? "Shared brain task lesson filtered" : "Shared brain task lesson capture failed",
            status: filtered ? "info" : "warning",
            summary: filtered
              ? "The task-derived candidate did not pass the deterministic 50% relevance gate; nothing was stored."
              : "Task planning completed, but optional automatic learning capture failed: " + message.slice(0, 140),
            requestId,
            project: parsed.data.project,
          });
        }
      }
    }
    const durationMs = Date.now() - startedAt;
    const usage = (await getBudgetSnapshot()).records.find(record => record.requestId === requestId);
    recordOperationalEvent({ source: "backend", event: "Task response returned", status: "success", summary: executionMode === "mock" ? "Mock plan returned. No model API or Figma edit was performed." : "Model gateway plan returned; no Figma edit was performed.", requestId, project: parsed.data.project, durationMs, mode: executionMode });
    const { learningCandidate: _privateLearningCandidate, ...publicPlan } = result.plan;
    return NextResponse.json({
      ...result,
      plan: publicPlan,
      learningCapture,
      requestId, mode: executionMode,
      cost: { currency: "INR", amount: usage?.estimatedCostInr ?? 0 },
      diagnostics: {
        durationMs, responseStatus: "success", figmaChangesMade: false,
        provider: usage?.provider ?? "mock", model: usage?.model ?? "mock/ux-direct",
        promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        sharedBrain: memoryRetrieval ? { status: memoryRetrieval.status, memoryCount: memoryRetrieval.memoryCount, knowledgeChunkCount: memoryRetrieval.knowledgeChunkCount, contextChars: memoryContext.length } : { status: "not-used", reason: "mock mode" }
      }
    }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create task plan";
    recordOperationalEvent({ source: "backend", event: "Task planning failed", status: "error", summary: message.slice(0, 220), requestId, project: parsed.data.project, durationMs: Date.now() - startedAt, mode: executionMode });
    const errorStatus = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status <= 599 ? error.status : 500;
    return NextResponse.json({ error: message, requestId }, { status: errorStatus, headers });
  }
}
