import { runBrainRetrievalEvals } from "@/src/memory/shared-brain";
import { brainNoStoreHeaders } from "@/src/security/shared-brain-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let lastRunStartedAt = 0;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required." }, { status: 403, headers: brainNoStoreHeaders() });
  }

  // Regression checks execute Postgres search only. They never call a model.
  if (Date.now() - lastRunStartedAt < 15_000) {
    return Response.json({ error: "A regression run was started recently. Refresh the status and try again shortly." }, {
      status: 429,
      headers: { ...brainNoStoreHeaders(), "Retry-After": "15" },
    });
  }
  lastRunStartedAt = Date.now();

  try {
    const result = await runBrainRetrievalEvals(50);
    return Response.json({
      ...result,
      modelInferenceCalls: 0,
      paidModelCalls: 0,
      executedAt: new Date().toISOString(),
    }, { headers: brainNoStoreHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retrieval regression run failed.";
    return Response.json({ error: message.slice(0, 400), modelInferenceCalls: 0, paidModelCalls: 0 }, {
      status: 500,
      headers: brainNoStoreHeaders(),
    });
  }
}
