import { z } from "zod";
import { retrieveBrainContext } from "@/src/memory/shared-brain";
import { errorResponse, brainNoStoreHeaders, isSharedBrainAuthorized, readJsonBody, unauthorizedBrainResponse, validateBrainScopes } from "@/src/security/shared-brain-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  query: z.string().trim().max(8000).default(""),
  scopeKeys: z.array(z.string()).max(8).optional(),
  limit: z.number().int().min(1).max(12).optional(),
  memoryTypes: z.array(z.string().max(60)).max(12).optional(),
  maxChars: z.number().int().min(600).max(5200).optional(),
  includeKnowledge: z.boolean().optional(),
}).strict();

export async function POST(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  try {
    const body = schema.parse(await readJsonBody(request));
    const scopeKeys = validateBrainScopes(body.scopeKeys);
    const context = await retrieveBrainContext({
      query: body.query,
      scopeKeys,
      limit: body.limit,
      memoryTypes: body.memoryTypes,
      maxChars: body.maxChars,
      includeKnowledge: body.includeKnowledge,
    });
    return Response.json({
      ...context,
      scopeKeys,
      source: "ux-direct-shared-brain",
      localModelCompatible: true,
    }, { headers: brainNoStoreHeaders() });
  } catch (error) {
    return errorResponse(error, "Shared-brain retrieval failed.");
  }
}
