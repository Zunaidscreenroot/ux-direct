import { NextResponse } from "next/server";
import { neonRequest } from "@/src/memory/neon-rest";
import { buildBrainMonitorReport, type TaskRunRow } from "@/src/memory/brain-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Counts-only (no prompts, memory text, ids or errors), cached briefly to bound DB load.
const headers = { "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex" };

export async function GET() {
  try {
    const rows = await neonRequest(
      "uxd_task_runs?select=outcome,status,duration_ms,retrieval,lesson,metadata,plan,error_summary,created_at,updated_at&order=updated_at.desc&limit=500",
    );
    const list = Array.isArray(rows) ? rows as TaskRunRow[] : [];
    return NextResponse.json({ ok: true, checkedAt: new Date().toISOString(), ...buildBrainMonitorReport(list) }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: "Brain monitor unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
