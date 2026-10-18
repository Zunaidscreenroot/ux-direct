import { brainNoStoreHeaders, isSharedBrainAuthorized, unauthorizedBrainResponse } from "@/src/security/shared-brain-auth";
import { listBrainEvalCases } from "@/src/memory/shared-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getRetrievalRegressionStatus() {
  try {
    const cases = await listBrainEvalCases(200);
    if (!cases.length) {
      return { status: "not_configured", configuredCases: 0, completedCases: 0, passed: 0, failed: 0, lastRunAt: null };
    }
    const runTimes = cases
      .map((item) => typeof item.last_run_at === "string" ? Date.parse(item.last_run_at) : NaN)
      .filter((value) => Number.isFinite(value));
    if (!runTimes.length) {
      return { status: "not_run", configuredCases: cases.length, completedCases: 0, passed: 0, failed: 0, lastRunAt: null };
    }
    const newest = Math.max(...runTimes);
    const latestRun = cases.filter((item) => {
      const timestamp = typeof item.last_run_at === "string" ? Date.parse(item.last_run_at) : NaN;
      return Number.isFinite(timestamp) && timestamp >= newest - 5 * 60 * 1000;
    });
    const passed = latestRun.filter((item) => Boolean(
      item.last_run_result && typeof item.last_run_result === "object"
        && (item.last_run_result as Record<string, unknown>).passed === true
    )).length;
    const failed = latestRun.filter((item) => Boolean(
      item.last_run_result && typeof item.last_run_result === "object"
        && (item.last_run_result as Record<string, unknown>).passed === false
    )).length;
    const complete = latestRun.length === cases.length;
    const status = !complete ? "partial" : failed > 0 ? "failed" : passed === cases.length ? "passed" : "partial";
    return {
      status,
      configuredCases: cases.length,
      completedCases: latestRun.length,
      passed,
      failed,
      lastRunAt: new Date(newest).toISOString(),
    };
  } catch {
    return { status: "unavailable", configuredCases: 0, completedCases: 0, passed: 0, failed: 0, lastRunAt: null };
  }
}

export async function GET(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  const retrievalRegressionTests = await getRetrievalRegressionStatus();
  return Response.json({
    service: "UX Direct shared brain",
    status: "configured",
    persistence: "Neon Postgres + Cloudflare R2",
    retrieval: ["Postgres full-text search", "tag/title matching", "approved reference chunks"],
    retrievalRegressionTests,
    semanticVectorSearch: "not_active_embeddings_empty",
    memoryModelIndependent: true,
    note: "Only approved memories and approved documents are retrieved. Feedback is draft-only until explicitly approved.",
    checkedAt: new Date().toISOString(),
  }, { headers: brainNoStoreHeaders() });
}
