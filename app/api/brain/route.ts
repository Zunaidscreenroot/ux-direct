import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  listBrainEvalCases,
  listBrainFeedback,
  retrieveBrainContext,
  reviewBrainFeedback,
  runBrainRetrievalEvaluations,
  saveBrainEvalCase,
  saveBrainFeedback,
  upsertBrainDocument,
  type BrainFeedbackInput,
} from "@/src/memory/shared-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 350_000;

function authorized(request: Request): boolean {
  const expected = process.env.UX_DIRECT_BRAIN_API_KEY || process.env.UX_DIRECT_MCP_API_KEY || "";
  const suppliedHeader = request.headers.get("authorization") || "";
  const supplied = suppliedHeader.startsWith("Bearer ") ? suppliedHeader.slice(7).trim() : "";
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)); } catch { return false; }
}
function text(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

/**
 * Private, server-to-server API for the UX Shared Brain.
 * UX Direct, UX Audit and the Figma-plugin backend may call this endpoint.
 * No browser/extension receives the shared brain API key.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return jsonError("Unauthorized shared-brain request.", 401);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return jsonError("Request body is too large.", 413);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return jsonError("Request body is too large.", 413);
    body = objectBody(raw ? JSON.parse(raw) : {});
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Malformed JSON body.", 400);
  }

  const action = text(body.action, 60);
  try {
    switch (action) {
      case "retrieve": {
        const result = await retrieveBrainContext({
          query: body.query,
          scopeKey: body.scopeKey,
          maxResults: body.maxResults,
          maxContextChars: body.maxContextChars,
          includeKnowledge: body.includeKnowledge !== false,
        });
        return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
      }
      case "save-feedback": {
        const feedback = await saveBrainFeedback({
          sourceProduct: body.sourceProduct as BrainFeedbackInput["sourceProduct"],
          scopeKey: body.scopeKey as BrainFeedbackInput["scopeKey"],
          feedbackKind: body.feedbackKind as BrainFeedbackInput["feedbackKind"],
          rawFeedback: text(body.rawFeedback, 8000),
          summary: text(body.summary, 1400),
          title: text(body.title, 240),
          normalizedRule: text(body.normalizedRule, 2000),
          rationale: text(body.rationale, 1400),
          keywords: Array.isArray(body.keywords) ? body.keywords.filter((v): v is string => typeof v === "string").slice(0, 30) : [],
          examples: Array.isArray(body.examples) ? body.examples.slice(0, 6) : [],
          originalLanguage: text(body.originalLanguage, 40) || "unknown",
          sourceAuditRef: text(body.sourceAuditRef, 300),
          sourceFindingTitle: text(body.sourceFindingTitle, 240),
          idempotencyKey: text(body.idempotencyKey, 180),
        });
        return NextResponse.json({ ok: true, feedback }, { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      case "list-feedback": {
        const feedback = await listBrainFeedback({
          ...(body.scopeKey !== undefined ? { scopeKey: body.scopeKey } : {}),
          status: body.status ?? "all",
          ...(body.sourceProduct !== undefined ? { sourceProduct: body.sourceProduct } : {}),
          limit: body.limit,
        });
        return NextResponse.json({ ok: true, count: feedback.length, feedback }, { headers: { "Cache-Control": "no-store" } });
      }
      case "review-feedback": {
        const feedback = await reviewBrainFeedback({
          feedbackId: body.feedbackId,
          action: body.reviewAction,
          reviewNote: body.reviewNote,
        });
        return NextResponse.json({ ok: true, feedback }, { headers: { "Cache-Control": "no-store" } });
      }
      case "upsert-document": {
        const document = await upsertBrainDocument({
          scopeKey: body.scopeKey, title: body.title, content: body.content,
          sourceUrl: body.sourceUrl, sourceType: body.sourceType,
          sourceAuthority: body.sourceAuthority, publishedAt: body.publishedAt,
          effectiveAt: body.effectiveAt, lastVerifiedAt: body.lastVerifiedAt,
          versionLabel: body.versionLabel, metadata: body.metadata,
          activate: body.activate === true,
        });
        return NextResponse.json({ ok: true, document }, { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      case "save-eval-case": {
        const result = await saveBrainEvalCase({
          scopeKey: body.scopeKey, capability: body.capability, title: body.title, query: body.query,
          expectedBehavior: body.expectedBehavior, forbiddenBehaviors: body.forbiddenBehaviors,
          expectedMemoryIds: body.expectedMemoryIds, activate: body.activate === true,
        });
        return NextResponse.json({ ok: true, evalCase: result }, { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      case "list-eval-cases": {
        const evalCases = await listBrainEvalCases({
          ...(body.scopeKey !== undefined ? { scopeKey: body.scopeKey } : {}),
          status: body.status ?? "all", limit: body.limit,
        });
        return NextResponse.json({ ok: true, count: evalCases.length, evalCases }, { headers: { "Cache-Control": "no-store" } });
      }
      case "run-evals": {
        const result = await runBrainRetrievalEvaluations({ scopeKey: body.scopeKey, limit: body.limit });
        return NextResponse.json({ ok: true, evaluation: result }, { headers: { "Cache-Control": "no-store" } });
      }
      default:
        return jsonError("Unsupported brain action. Supported actions: retrieve, save-feedback, list-feedback, review-feedback, upsert-document, save-eval-case, list-eval-cases, run-evals.", 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shared Brain request failed.";
    console.error("[uxd-brain] request failed", JSON.stringify({ action, error: message.slice(0, 240) }));
    return jsonError(message.slice(0, 500), /required|must be|unsupported|UUID|between|not found/i.test(message) ? 400 : 503);
  }
}

export async function GET() {
  return jsonError("Use the authenticated POST interface.", 405);
}
