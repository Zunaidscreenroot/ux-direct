import { z } from "zod";
import { runBrainRetrievalEvals } from "@/src/memory/shared-brain";
import { errorResponse, brainNoStoreHeaders, isSharedBrainAuthorized, readJsonBody, unauthorizedBrainResponse } from "@/src/security/shared-brain-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  try {
    const body = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().parse(await readJsonBody(request, 4000));
    const result = await runBrainRetrievalEvals(body.limit ?? 50);
    return Response.json({ ...result, modelInferenceCalls: 0, paidModelCalls: 0 }, { headers: brainNoStoreHeaders() });
  } catch (error) {
    return errorResponse(error, "Shared-brain evaluation failed.");
  }
}
