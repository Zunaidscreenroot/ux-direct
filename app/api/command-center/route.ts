import { NextResponse } from "next/server";
import { commandCenterLockedResponse, isCommandCenterAuthorized } from "@/src/command-center/access";
import { ACTIVITY_WINDOW_DAYS, loadRecentActivity, summarizeActivity } from "@/src/command-center/activity";
import { loadSharedKnowledge } from "@/src/command-center/knowledge";
import { loadModelAnalytics } from "@/src/command-center/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/** Read-only command-center data: ?view=activity | knowledge | models. Same-origin dashboard only. */
export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  }
  if (!isCommandCenterAuthorized(request)) return commandCenterLockedResponse();
  const view = new URL(request.url).searchParams.get("view");
  try {
    if (view === "activity") {
      const items = await loadRecentActivity(ACTIVITY_WINDOW_DAYS);
      return NextResponse.json({ items, summary: summarizeActivity(items) }, { headers });
    }
    if (view === "models") {
      const hours = Number(new URL(request.url).searchParams.get("hours")) || 24;
      return NextResponse.json(await loadModelAnalytics(hours), { headers });
    }
    if (view === "knowledge") {
      return NextResponse.json(await loadSharedKnowledge(), { headers });
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 200) : "Command center data is unavailable." },
      { status: 503, headers },
    );
  }
}
