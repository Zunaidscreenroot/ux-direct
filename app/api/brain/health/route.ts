import { brainNoStoreHeaders, isSharedBrainAuthorized, unauthorizedBrainResponse } from "@/src/security/shared-brain-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  return Response.json({
    service: "UX Direct shared brain",
    status: "configured",
    persistence: "Neon Postgres + Cloudflare R2",
    retrieval: ["Postgres full-text search", "tag/title matching", "approved reference chunks"],
    memoryModelIndependent: true,
    note: "Only approved memories and approved documents are retrieved. Feedback is draft-only until explicitly approved.",
    checkedAt: new Date().toISOString(),
  }, { headers: brainNoStoreHeaders() });
}
