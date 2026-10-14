import { NextResponse } from "next/server";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import { isAllowedPluginOrigin, pluginCorsHeaders, getDailyPaidModelBudgetStatus, getDailyPaidModelBudgetLedger } from "@/src/figma/plugin-ai-api";
import { getModelLearningOverview } from "@/src/figma/model-learning";
import { getOpenRouterSpendMonitoring } from "@/src/figma/openrouter-monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: pluginCorsHeaders(request) });
}

export async function GET(request: Request) {
  if (!isAllowedPluginOrigin(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: pluginCorsHeaders(request) });
  }
  const fileKey = new URL(request.url).searchParams.get("fileKey");
  if (!isAllowedFigmaFileKey(fileKey)) {
    return NextResponse.json({ error: "Figma file is not allowlisted." }, { status: 403, headers: pluginCorsHeaders(request) });
  }

  const [openRouter, learning, dailyBudget, dailyBudgetLedger] = await Promise.all([
    getOpenRouterSpendMonitoring(),
    getModelLearningOverview(),
    getDailyPaidModelBudgetStatus(),
    getDailyPaidModelBudgetLedger(8),
  ]);
  return NextResponse.json({
    openRouter,
    learning,
    dailyBudget,
    dailyBudgetLedger,
    checkedAt: new Date().toISOString(),
  }, { headers: pluginCorsHeaders(request) });
}
