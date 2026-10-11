import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { planUXTask } from "@/src/core/orchestrator";
import { mockProvider } from "@/src/providers/mock-provider";
import { gatewayProvider } from "@/src/providers/gateway-provider";
import { providersFromEnv } from "@/src/model-gateway";
import { getBudgetSnapshot } from "@/src/model-gateway/usage-store";
import { recordOperationalEvent } from "@/src/observability/event-log";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";

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
  const taskInput = { title: parsed.data.title, request: parsed.data.request, project: parsed.data.project };
  const configuredProviders = providersFromEnv();
  const hasLocalOrFreeProvider = configuredProviders.some(provider => provider.kind === "local" || provider.kind === "free-tier");
  const explicitlySelectedPaidModel = process.env.ALLOW_PAID_MODELS === "true" &&
    Boolean(process.env.MODEL_GATEWAY_TASK_MODEL) &&
    configuredProviders.some(provider => provider.kind === "paid" && provider.models.includes(process.env.MODEL_GATEWAY_TASK_MODEL!));
  const selectedProvider = hasLocalOrFreeProvider || explicitlySelectedPaidModel ? gatewayProvider : mockProvider;
  const executionMode = selectedProvider === mockProvider ? "mock" : "gateway";
  recordOperationalEvent({ source: "backend", event: "Task request received", status: "info", summary: "Task planning request accepted; prompt contents are not stored in the operational log.", requestId, project: parsed.data.project, mode: executionMode });
  try {
    const result = await planUXTask({ ...taskInput, requestId, provider: selectedProvider });
    const durationMs = Date.now() - startedAt;
    const usage = getBudgetSnapshot().records.find(record => record.requestId === requestId);
    recordOperationalEvent({ source: "backend", event: "Task response returned", status: "success", summary: executionMode === "mock" ? "Mock plan returned. No model API or Figma edit was performed." : "Model gateway plan returned; no Figma edit was performed.", requestId, project: parsed.data.project, durationMs, mode: executionMode });
    return NextResponse.json({
      ...result, requestId, mode: executionMode,
      cost: { currency: "INR", amount: usage?.estimatedCostInr ?? 0 },
      diagnostics: {
        durationMs, responseStatus: "success", figmaChangesMade: false,
        provider: usage?.provider ?? "mock", model: usage?.model ?? "mock/ux-direct",
        promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0
      }
    }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create task plan";
    recordOperationalEvent({ source: "backend", event: "Task planning failed", status: "error", summary: message.slice(0, 220), requestId, project: parsed.data.project, durationMs: Date.now() - startedAt, mode: executionMode });
    return NextResponse.json({ error: message, requestId }, { status: 500, headers });
  }
}
