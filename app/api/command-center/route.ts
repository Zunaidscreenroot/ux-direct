import { NextResponse } from "next/server";
import { commandCenterLockedResponse, isCommandCenterAuthorized } from "@/src/command-center/access";
import { ACTIVITY_WINDOW_DAYS, loadRecentActivity, summarizeActivity } from "@/src/command-center/activity";
import { loadSharedKnowledge } from "@/src/command-center/knowledge";
import { MODELS_TABS, checkGatewayProviders, loadModelAnalytics, loadModelBudget } from "@/src/command-center/models";
import { pageParams, slicePage } from "@/src/command-center/paging";

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
      // Summary covers the whole window; only one small page of rows is sent ("View more" asks for the next).
      const items = await loadRecentActivity(ACTIVITY_WINDOW_DAYS);
      const { offset, limit } = pageParams(new URL(request.url));
      return NextResponse.json({ ...slicePage(items, offset, limit), summary: summarizeActivity(items) }, { headers });
    }
    if (view === "models-check") {
      return NextResponse.json(await checkGatewayProviders(), { headers });
    }
    if (view === "models-budget") {
      return NextResponse.json(await loadModelBudget(), { headers });
    }
    if (view === "models") {
      const params = new URL(request.url).searchParams;
      const hours = Number(params.get("hours")) || 24;
      const tab = MODELS_TABS.find((item) => item === params.get("tab"));
      return NextResponse.json(await loadModelAnalytics(hours, tab), { headers });
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
