import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { planUXTask } from "@/src/core/orchestrator";
import { mockProvider } from "@/src/providers/mock-provider";
import { recordOperationalEvent } from "@/src/observability/event-log";

const requestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(5).max(8000),
  project: z.enum(["general", "express-computers", "dmi-finance"]),
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
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
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
  recordOperationalEvent({ source: "backend", event: "Task request received", status: "info", summary: "Task planning request accepted; prompt contents are not stored in the operational log.", requestId, project: parsed.data.project, mode: "mock" });
  try {
    const result = await planUXTask({ ...parsed.data, provider: mockProvider });
    const durationMs = Date.now() - startedAt;
    recordOperationalEvent({ source: "backend", event: "Task response returned", status: "success", summary: "Mock plan returned to caller. No model API or Figma edit was performed.", requestId, project: parsed.data.project, durationMs, mode: "mock" });
    return NextResponse.json({ ...result, requestId, mode: "mock", cost: { currency: "INR", amount: 0 }, diagnostics: { durationMs, responseStatus: "success", figmaChangesMade: false } }, { headers });
  } catch {
    recordOperationalEvent({ source: "backend", event: "Task planning failed", status: "error", summary: "The planner could not create a task plan.", requestId, project: parsed.data.project, durationMs: Date.now() - startedAt, mode: "mock" });
    return NextResponse.json({ error: "Could not create task plan", requestId }, { status: 500, headers });
  }
}
