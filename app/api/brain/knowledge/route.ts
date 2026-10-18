import { z } from "zod";
import { addBrainKnowledgeDocument, listBrainKnowledgeDocuments, reviewBrainKnowledgeDocument } from "@/src/memory/shared-brain";
import { errorResponse, brainNoStoreHeaders, isSharedBrainAuthorized, readJsonBody, unauthorizedBrainResponse, validateBrainScopes } from "@/src/security/shared-brain-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sources = z.enum(["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"]);
const addSchema = z.object({
  action: z.literal("add"),
  document: z.object({
    title: z.string().trim().min(1).max(240),
    content: z.string().trim().min(1).max(100000),
    projectKey: z.string().max(100).optional(),
    sourceUrl: z.string().url().max(1800).optional(),
    sourceType: z.string().max(60).optional(),
    sourceAuthority: z.string().max(60).optional(),
    status: z.enum(["draft","approved"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sourceProduct: sources.optional(),
  }).strict(),
}).strict();
const listSchema = z.object({ action: z.literal("list"), status: z.enum(["all","draft","approved","rejected","archived","failed"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const reviewSchema = z.object({ action: z.literal("review"), documentId: z.string().uuid(), decision: z.enum(["approve","reject","archive"]) }).strict();
const schema = z.discriminatedUnion("action",[addSchema,listSchema,reviewSchema]);

export async function POST(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  try {
    const input = schema.parse(await readJsonBody(request, 140000));
    if (input.action === "add") {
      validateBrainScopes([input.document.projectKey || "UX_SHARED_BRAIN"]);
      const result = await addBrainKnowledgeDocument(input.document);
      return Response.json({ document: result, nextAction: "Review and approve the reference before retrieval can use it." }, { status: 201, headers: brainNoStoreHeaders() });
    }
    if (input.action === "list") {
      const documents = await listBrainKnowledgeDocuments(input);
      return Response.json({ documents, count: documents.length }, { headers: brainNoStoreHeaders() });
    }
    const result = await reviewBrainKnowledgeDocument({ documentId: input.documentId, action: input.decision });
    return Response.json({ result }, { headers: brainNoStoreHeaders() });
  } catch (error) {
    return errorResponse(error, "Shared-brain knowledge request failed.");
  }
}
