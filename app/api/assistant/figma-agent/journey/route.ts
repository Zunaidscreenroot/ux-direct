import { NextResponse } from "next/server";
import { z } from "zod";
import { callFigmaJsonModel } from "@/src/figma-agent/json-model-call";
import { JOURNEY_SYSTEM, fallbackJourney, normalizeJourney } from "@/src/figma-agent/journey-plan";
import { isAllowedPluginOrigin, pluginCorsHeaders, pluginOptions } from "@/src/figma-agent/route-cors";
import { recordQuickTask } from "@/src/memory/task-run-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return pluginOptions(request);
}

/**
 * Journey plan for "create a journey / flow …": the ordered screens (steps, success, failure) with
 * one primary action each. The plugin builds each screen with the normal create path and one shared
 * kit, then wires the prototype. Falls back to a generic task journey when no free model answers.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const response = await handleJourney(request);
  recordQuickTask("journey", startedAt, response);
  return response;
}

async function handleJourney(request: Request): Promise<Response> {
  const headers = pluginCorsHeaders(request);
  if (!isAllowedPluginOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.object({ prompt: z.string().trim().min(1).max(4000) }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Journey input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  const prompt = parsed.data.prompt;
  const result = await callFigmaJsonModel({
    title: "UX Direct Journey Plan",
    origin: new URL(request.url).origin,
    hasVisionInput: false,
    role: "lead",
    maxTokens: 1500,
    temperature: 0.3,
    anyObject: true,
    system: JOURNEY_SYSTEM,
    user: JSON.stringify({ request: prompt }),
    accept: (data) => normalizeJourney(data, prompt) ? null : "returned fewer than 2 journey steps",
  });
  const plan = result.ok ? normalizeJourney(result.data, prompt) : null;
  return NextResponse.json({ ok: true, plan: plan ?? fallbackJourney(prompt), model: plan && result.ok ? result.model : "rule-based" }, { headers });
}
