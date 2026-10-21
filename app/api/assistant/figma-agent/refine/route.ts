import { NextResponse } from "next/server";
import { z } from "zod";
import { FIGMA_AGENT_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";
import { extractJsonObject } from "@/src/figma-agent/extract-json-object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin);
}
function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const permitted = origin && (origin === new URL(request.url).origin || ALLOWED_ORIGINS.has(origin));
  return {
    ...(permitted ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
const PatchSchema = z.object({
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
  width: z.number().finite().min(1).max(4096).optional(),
  height: z.number().finite().min(1).max(4096).optional(),
  fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(100).optional(),
  arcData: z.object({
    startingAngle: z.number().finite().min(-6.283185307179586).max(6.283185307179586),
    endingAngle: z.number().finite().min(-6.283185307179586).max(6.283185307179586),
    innerRadius: z.number().finite().min(0).max(1),
  }).strict().optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  fontSize: z.number().finite().min(8).max(144).optional(),
  text: z.string().max(5000).optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
  lineHeight: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(1).max(500) }).strict().optional(),
  letterSpacing: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(-100).max(500) }).strict().optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional(),
  layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
  layoutGrow: z.number().finite().min(0).max(1).optional(),
  itemSpacing: z.number().finite().min(-100).max(1000).optional(),
  paddingLeft: z.number().finite().min(0).max(1000).optional(),
  paddingRight: z.number().finite().min(0).max(1000).optional(),
  paddingTop: z.number().finite().min(0).max(1000).optional(),
  paddingBottom: z.number().finite().min(0).max(1000).optional(),
  primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
  shadowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  shadowBlur: z.number().finite().min(0).max(200).optional(),
  shadowX: z.number().finite().min(-200).max(200).optional(),
  shadowY: z.number().finite().min(-200).max(200).optional(),
  shadowSpread: z.number().finite().min(-200).max(200).optional(),
}).strict().refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "Empty patch." });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function compactNode(value: unknown, depth: number, seen: Map<string, Record<string, unknown>>): unknown {
  if (!isRecord(value) || depth > 4) return null;
  const id = typeof value.id === "string" ? value.id.slice(0, 100) : "";
  const type = typeof value.type === "string" ? value.type.slice(0, 40) : "";
  const node: Record<string, unknown> = { id, type };
  seen.set(id, value);
  for (const key of ["name", "text"] as const) {
    if (typeof value[key] === "string") node[key] = (value[key] as string).slice(0, key === "text" ? 280 : 100);
  }
  for (const key of ["x", "y", "width", "height", "fontSize", "childCount", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) node[key] = value[key];
  }
  for (const key of ["layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning",
    "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize"] as const) {
    if (typeof value[key] === "string") node[key] = value[key].slice(0, 40);
  }
  if (Array.isArray(value.children)) {
    node.children = value.children.slice(0, 35).map((child) => compactNode(child, depth + 1, seen)).filter(Boolean);
  }
  return node;
}
export async function OPTIONS(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}
export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!isAllowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return NextResponse.json({ error: "OpenRouter is not configured." }, { status: 503, headers });
  const body: unknown = await request.json().catch(() => null);
  const parsed = z.object({
    prompt: z.string().trim().min(2).max(5000),
    review: z.object({
      issues: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), issue: z.string(), evidence: z.string(), fix: z.string() }).passthrough()).max(12),
      score: z.number().min(0).max(100),
      summary: z.string().optional(),
    }).passthrough(),
    outputCanvas: z.unknown(),
    iteration: z.number().int().min(1).max(2),
  }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Refinement input is invalid.", details: parsed.error.issues }, { status: 400, headers });

  const root = parsed.data.outputCanvas;
  if (!isRecord(root) || !Array.isArray(root.nodes) || !root.nodes.length) {
    return NextResponse.json({ error: "Generated variation node tree is missing." }, { status: 400, headers });
  }
  const found = new Map<string, Record<string, unknown>>();
  const modelTree = compactNode(root.nodes[0], 0, found);
  if (!found.size || !Array.from(found.keys()).some((id) => id.length > 0)) {
    return NextResponse.json({ error: "Generated variation contains no editable native node IDs." }, { status: 400, headers });
  }
  const endpoint = ((process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "")) + "/chat/completions";
  const models = FIGMA_AGENT_MODELS.map((entry) => entry.id);
  const errors: string[] = [];
  for (const [modelIndex, model] of models.entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), modelIndex === 0 ? 24000 : 20000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", Accept: "application/json",
          "HTTP-Referer": new URL(request.url).origin, "X-OpenRouter-Title": "UX Direct Design Refiner" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: [
              UX_DIRECT_DESIGN_ROLE + " You are UX Direct's surgical native-Figma refinement agent. Return JSON only: {patch:[{nodeId:string,patch:object}]}.",
              "Fix only the supplied visual review issues with the smallest sensible adjustments. Preserve information architecture and visual language. Never redesign the screen wholesale.",
              "Each nodeId MUST come from the supplied generated-frame tree. Allowed patch fields are limited to native Figma update-node: x,y,width,height,fillColor,strokeColor,strokeWeight,opacity,cornerRadius,fontFamily,fontStyle,fontSize,text,textAlignHorizontal,textAlignVertical,textAutoResize,lineHeight,letterSpacing,layoutMode,layoutWrap,layoutSizingHorizontal,layoutSizingVertical,layoutPositioning,layoutGrow,itemSpacing,paddingLeft,paddingRight,paddingTop,paddingBottom,primaryAxisAlignItems,counterAxisAlignItems,shadowColor,shadowBlur,shadowX,shadowY,shadowSpread,arcData. Only apply arcData to ELLIPSE nodes, text properties to TEXT nodes, container layout properties to FRAME nodes, and sizing/positioning to children of native Auto Layout parents.",
              "Do not target nodes outside the generated variation. Return no more than 20 patches.",
            ].join("\n") },
            { role: "user", content: JSON.stringify({ prompt: parsed.data.prompt, iteration: parsed.data.iteration, score: parsed.data.review.score,
              issues: parsed.data.review.issues, generatedFrameTree: modelTree }) },
          ],
          temperature: 0.1,
          max_tokens: 2400,
          response_format: { type: "json_object" },
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = isRecord(payload) ? payload : {};
      if (!response.ok) {
        const err = isRecord(record.error) ? record.error : {};
        errors.push(model + ": " + String(err.message || "HTTP " + response.status).slice(0, 160));
        continue;
      }
      const choices = Array.isArray(record.choices) ? record.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const message = isRecord(choice.message) ? choice.message : {};
      const rawPlan = extractJsonObject(message.content) ?? extractJsonObject(message.parsed) ?? extractJsonObject(message.tool_calls) ?? extractJsonObject(message);
      const schema = z.object({
        patch: z.array(z.object({ nodeId: z.string().trim().min(1).max(100), patch: PatchSchema }).strict()).max(20),
      }).strict();
      const result = schema.safeParse(rawPlan);
      if (!result.success) {
        errors.push(model + ": invalid patch schema");
        continue;
      }
      // Keep only native node IDs found in this generated tree; the client independently repeats this guard.
      const patch = result.data.patch.filter((entry) => {
        const node = found.get(entry.nodeId);
        return !!node && typeof node.id === "string" && !["DOCUMENT", "PAGE"].includes(String(node.type || ""));
      });
      if (parsed.data.review.score < 90 && patch.length === 0) {
        errors.push(model + ": quality score is below 90 but the model returned no actionable patches");
        continue;
      }
      return NextResponse.json({
        ok: true,
        patch,
        refinementRequired: parsed.data.review.score < 90 || parsed.data.review.issues.some(issue => issue.severity === "high"),
        model: typeof record.model === "string" ? record.model : model
      }, { headers });
    } catch (error) {
      errors.push(model + ": " + (controller.signal.aborted ? "timed out" : error instanceof Error ? error.message.slice(0, 140) : "request failed"));
    } finally {
      clearTimeout(timer);
    }
  }
  return NextResponse.json({ error: "Visual refinement could not complete.", details: errors.slice(0, 2) }, { status: 502, headers });
}
