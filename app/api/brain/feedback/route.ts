import { z } from "zod";
import { listBrainFeedback, reviewBrainFeedback, saveBrainFeedback } from "@/src/memory/shared-brain";
import { errorResponse, brainNoStoreHeaders, isSharedBrainAuthorized, readJsonBody, unauthorizedBrainResponse, validateBrainScopes } from "@/src/security/shared-brain-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const feedbackSchema = z.object({
  rawFeedback: z.string().trim().min(1).max(12000),
  summary: z.string().max(1200).optional(),
  title: z.string().trim().min(1).max(180),
  normalizedRule: z.string().trim().min(1).max(2400),
  rationale: z.string().max(1800).optional(),
  scopeKey: z.string().max(100).optional(),
  feedbackKind: z.enum(["general","false_positive","missed_issue","severity_calibration","recommendation_quality","duplicate_finding","benchmarking","scope","visual_evidence","accessibility","interaction_logic","design_system","cost_optimization","other"]).optional(),
  keywords: z.array(z.string().max(64)).max(32).optional(),
  examples: z.array(z.unknown()).max(8).optional(),
  originalLanguage: z.string().max(60).optional(),
  sourceProduct: z.enum(["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"]),
  sourceAuditRef: z.string().max(120).optional(),
  sourceFindingTitle: z.string().max(240).optional(),
  idempotencyKey: z.string().max(180).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const listSchema = z.object({
  action: z.literal("list"),
  status: z.enum(["all","draft","approved","rejected","archived"]).optional(),
  sourceProduct: z.enum(["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const reviewSchema = z.object({
  action: z.literal("review"),
  feedbackId: z.string().uuid(),
  decision: z.enum(["approve","reject","archive"]),
  reviewNote: z.string().max(1000).optional(),
}).strict();

const saveSchema = z.object({ action: z.literal("save"), feedback: feedbackSchema }).strict();
const rootSchema = z.discriminatedUnion("action", [saveSchema, listSchema, reviewSchema]);

export async function POST(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  try {
    const input = rootSchema.parse(await readJsonBody(request));
    if (input.action === "save") {
      validateBrainScopes([input.feedback.scopeKey || "UX_SHARED_BRAIN"]);
      const result = await saveBrainFeedback(input.feedback);
      return Response.json({ feedback: result, activation: "draft-only", nextAction: "Review and explicitly approve the feedback before it affects future model context." }, { status: 201, headers: brainNoStoreHeaders() });
    }
    if (input.action === "list") {
      const feedback = await listBrainFeedback(input);
      return Response.json({ feedback, count: feedback.length }, { headers: brainNoStoreHeaders() });
    }
    validateBrainScopes([String((await listBrainFeedback({ status: "all", limit: 1 })).find(row => row.id === input.feedbackId)?.scope_key || "UX_SHARED_BRAIN")]);
    const result = await reviewBrainFeedback({ feedbackId: input.feedbackId, action: input.decision, reviewNote: input.reviewNote });
    return Response.json({ result }, { headers: brainNoStoreHeaders() });
  } catch (error) {
    return errorResponse(error, "Shared-brain feedback request failed.");
  }
}
