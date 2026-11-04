import { NextResponse } from "next/server";
import { brainNoStoreHeaders, isSharedBrainAuthorized, unauthorizedBrainResponse } from "@/src/security/shared-brain-auth";
import { neonRequest } from "@/src/memory/neon-rest";
import { aggregateModelStats } from "@/src/memory/verified-specs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Figma-agent outcomes per upstream model (what FreeLLMAPI `auto` actually picked). */
export async function GET(request: Request) {
  if (!isSharedBrainAuthorized(request)) return unauthorizedBrainResponse();
  try {
    const rows = await neonRequest("uxd_task_runs?select=outcome,metadata&order=updated_at.desc&limit=500");
    const list = Array.isArray(rows) ? rows as Array<{ outcome?: unknown; metadata?: unknown }> : [];
    return NextResponse.json({ ok: true, window: list.length, models: aggregateModelStats(list) }, { headers: brainNoStoreHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "Model stats unavailable." },
      { status: 503, headers: brainNoStoreHeaders() });
  }
}
