import { NextResponse } from "next/server";
import { z } from "zod";
import { runHygieneCheck, formatHygieneReport } from "@/src/figma-agent/hygiene-check";
import { callFigmaJsonModel, type JsonModelContent } from "@/src/figma-agent/json-model-call";
import { normalizeUxAudit, formatUxAudit, compactAuditCanvas } from "@/src/figma-agent/ux-audit-review";
import { auditImageSchema } from "@/src/figma-agent/audit-input";
import { isAllowedPluginOrigin, pluginCorsHeaders, pluginOptions } from "@/src/figma-agent/route-cors";
import { recordQuickTask } from "@/src/memory/task-run-log";
import { designRulesBlock } from "@/src/figma-agent/design-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: Request) {
  return pluginOptions(request);
}


/**
 * Review the selected screen(s).
 * - kind "hygiene": deterministic UI hygiene / consistency lint, no model call.
 * - kind "ux": UX audit by the free model from screenshots + layer tree, with the
 *   hygiene findings attached as objective evidence.
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  const response = await handleAuditTask(request);
  recordQuickTask("audit", startedAt, response);
  return response;
}

async function handleAuditTask(request: Request): Promise<Response> {
  const headers = pluginCorsHeaders(request);
  if (!isAllowedPluginOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.object({
    kind: z.enum(["ux", "hygiene"]),
    prompt: z.string().trim().min(1).max(4000),
    canvas: z.unknown(),
    screens: z.array(z.object({ id: z.string().max(100), name: z.string().max(200), image: auditImageSchema.nullable().optional() }).strict()).max(6).optional(),
    styleCounts: z.object({ paint: z.number().int().min(0), text: z.number().int().min(0), variables: z.number().int().min(0) }).partial().optional(),
    /** The file's own design rules: the UX audit judges spacing, type and colour against them. */
    designRules: z.string().max(4000).optional(),
  }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Review input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  if (JSON.stringify(parsed.data.canvas ?? null).length > 900_000) {
    return NextResponse.json({ error: "Selection is too large to review; select fewer screens." }, { status: 413, headers });
  }
  const counts = parsed.data.styleCounts || {};
  const hygiene = runHygieneCheck(parsed.data.canvas, { paintStyles: counts.paint, textStyles: counts.text, variables: counts.variables });
  if (parsed.data.kind === "hygiene") {
    return NextResponse.json({ ok: true, kind: "hygiene", report: hygiene, text: formatHygieneReport(hygiene) }, { headers });
  }

  const screens = parsed.data.screens || [];
  const images = screens.filter((screen) => screen.image);
  const userContent: JsonModelContent = [{
    type: "text",
    text: JSON.stringify({
      request: parsed.data.prompt,
      screens: screens.map((screen, index) => ({ order: index + 1, id: screen.id, name: screen.name, hasScreenshot: Boolean(screen.image) })),
      layerTree: compactAuditCanvas(parsed.data.canvas),
      objectiveHygieneFindings: hygiene.issues.slice(0, 8).map((issue) => ({ severity: issue.severity, issue: issue.issue, evidence: issue.evidence })),
    }),
  }];
  for (const screen of images) userContent.push({ type: "image_url", image_url: { url: screen.image! } });

  const result = await callFigmaJsonModel({
    title: "UX Direct UX Audit",
    origin: new URL(request.url).origin,
    hasVisionInput: images.length > 0,
    role: "critic",
    maxTokens: 2200,
    temperature: 0.2,
    system: [
      "You are a senior UX reviewer auditing the selected Figma screen(s)" + (screens.length > 1 ? " as one user flow, in the given order" : "") + ".",
      "Use Nielsen's 10 heuristics, clarity of the primary task, information hierarchy, copy clarity, error/empty/loading states, form usability, trust and accessibility (WCAG AA).",
      screens.length > 1 ? "Also judge the flow: missing steps, dead ends, inconsistent patterns between screens, back/cancel paths, progress feedback." : "",
      "Every finding must cite something visible in the screenshots or present in the layer tree (quote the text or name the element). Do not invent content. If screenshots are missing, say the audit is structural.",
      "Return JSON only: {summary:string, score:number 0-100, strengths:string[] (max 3), findings:[{severity:'high'|'medium'|'low', heuristic:string, screen:string, element:string, nodeId?:string, issue:string, fix:string}] (3-10 items, most severe first)}.",
      "nodeId must be an id from layerTree when you can match the element, otherwise omit it.",
      designRulesBlock(parsed.data.designRules) ? designRulesBlock(parsed.data.designRules).trim() + "\nReport a deviation from these file rules as a finding (heuristic: \"File design rules\")." : "",
    ].filter(Boolean).join("\n"),
    user: userContent,
    accept: (data) => normalizeUxAudit(data) ? null : "response did not match the UX audit schema",
  });
  if (!result.ok) return NextResponse.json({ error: result.error, details: result.errors }, { status: result.status, headers });
  const audit = normalizeUxAudit(result.data)!;
  return NextResponse.json({
    ok: true, kind: "ux", audit, hygiene, model: result.model,
    text: formatUxAudit(audit, images.length, screens.length) +
      "\n\nObjective UI hygiene score: " + hygiene.score + "/100 (" + hygiene.issues.length + " issue(s)). Ask \"run a hygiene check\" for the full list.",
  }, { headers });
}
