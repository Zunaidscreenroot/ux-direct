import { NextResponse } from "next/server";
import { z } from "zod";
import { buildBrainSystemPrompt, resolveBrainScopes, type BrainContextPromptInput } from "@/src/memory/chat-context";
import { retrieveBrainContext } from "@/src/memory/shared-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || API_ORIGINS.has(origin);
}
function cors(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const ok = origin && (origin === new URL(request.url).origin || API_ORIGINS.has(origin));
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

const ElementSchema = z.object({
  type: z.enum(["RECTANGLE", "ELLIPSE", "TEXT", "LINE", "FRAME", "POLYGON", "STAR"]),
  name: z.string().trim().min(1).max(80),
  x: z.number().finite().min(-1000).max(5000),
  y: z.number().finite().min(-1000).max(5000),
  width: z.number().finite().min(1).max(4096),
  height: z.number().finite().min(1).max(4096),
  text: z.string().max(1800).optional(),
  fontSize: z.number().finite().min(8).max(96).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(20).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  cornerRadius: z.number().finite().min(0).max(128).optional(),
  clipsContent: z.boolean().optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
  itemSpacing: z.number().finite().min(0).max(160).optional(),
  paddingLeft: z.number().finite().min(0).max(160).optional(),
  paddingRight: z.number().finite().min(0).max(160).optional(),
  paddingTop: z.number().finite().min(0).max(160).optional(),
  paddingBottom: z.number().finite().min(0).max(160).optional(),
  primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
  primaryAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
  counterAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  shadowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  shadowBlur: z.number().finite().min(0).max(80).optional(),
  shadowX: z.number().finite().min(-30).max(30).optional(),
  shadowY: z.number().finite().min(-30).max(30).optional(),
  shadowSpread: z.number().finite().min(-30).max(30).optional(),
}).strict().superRefine((item, ctx) => {
  if (item.type === "TEXT" && typeof item.text !== "string") {
    ctx.addIssue({ code: "custom", path: ["text"], message: "TEXT elements require text." });
  }
});
const PlanSchema = z.object({
  summary: z.string().trim().min(8).max(700),
  frame: z.object({
    name: z.string().trim().min(1).max(80),
    width: z.number().int().min(280).max(1440),
    height: z.number().int().min(360).max(4096),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).strict(),
  elements: z.array(ElementSchema).min(5).max(80),
}).strict();

type CanvasNode = {
  id?: string; name?: string; type?: string; x?: number; y?: number;
  width?: number; height?: number; text?: string; fontSize?: number;
  fillColors?: string[]; visible?: boolean; layoutMode?: string;
  childCount?: number; children?: CanvasNode[];
};
function compactNode(value: unknown, state: { count: number }, depth = 0): CanvasNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || state.count >= 100) return null;
  const node = value as Record<string, unknown>;
  if (typeof node.name !== "string" || typeof node.type !== "string") return null;
  state.count += 1;
  const out: CanvasNode = { name: node.name.slice(0, 120), type: node.type.slice(0, 40) };
  for (const key of ["id", "x", "y", "width", "height", "text", "fontSize", "visible", "layoutMode", "childCount"] as const) {
    const valueAtKey = node[key];
    if (key === "id" && typeof valueAtKey === "string") out.id = valueAtKey.slice(0, 100);
    if (["x", "y", "width", "height", "fontSize", "childCount"].includes(key) && typeof valueAtKey === "number" && Number.isFinite(valueAtKey)) (out as unknown as Record<string, unknown>)[key] = valueAtKey;
    if (key === "text" && typeof valueAtKey === "string") out.text = valueAtKey.slice(0, 350);
    if (key === "visible" && typeof valueAtKey === "boolean") out.visible = valueAtKey;
    if (key === "layoutMode" && typeof valueAtKey === "string") out.layoutMode = valueAtKey.slice(0, 20);
  }
  if (Array.isArray(node.fillColors)) out.fillColors = node.fillColors.filter((color): color is string => typeof color === "string").slice(0, 4);
  if (depth < 4 && Array.isArray(node.children)) {
    out.children = [];
    for (const child of node.children.slice(0, 50)) {
      const compact = compactNode(child, state, depth + 1);
      if (compact) out.children.push(compact);
      if (state.count >= 100) break;
    }
  }
  return out;
}
function compactCanvas(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { pageName: "Unknown page", nodes: [] };
  const canvas = value as Record<string, unknown>;
  const state = { count: 0 };
  const nodes = Array.isArray(canvas.nodes)
    ? canvas.nodes.slice(0, 20).map((node) => compactNode(node, state)).filter((node): node is CanvasNode => !!node)
    : [];
  return {
    pageName: typeof canvas.pageName === "string" ? canvas.pageName.slice(0, 120) : "Unknown page",
    scope: typeof canvas.scope === "string" ? canvas.scope.slice(0, 40) : "selection",
    nodeCount: state.count,
    truncated: canvas.truncated === true || state.count >= 100,
    nodes,
    viewport: canvas.viewport && typeof canvas.viewport === "object" ? canvas.viewport : undefined,
    styles: canvas.styles && typeof canvas.styles === "object" ? canvas.styles : undefined,
  };
}

const SYSTEM = [
  "You are UX Direct's native Figma design agent. The user explicitly requested a design action.",
  "Return ONLY one JSON object matching this schema: {summary:string, frame:{name:string,width:number,height:number,backgroundColor:'#RRGGBB'}, elements:[element...]}. Do not wrap JSON in markdown.",
  "Create a polished, high-fidelity native Figma screen using only native shapes and text layers. Do not use images, external assets, or invented APIs.",
  "The frame's children are FLAT direct children; element x/y coordinates are relative to the new frame's top-left. Position layers back-to-front; rectangles first, then text and controls. Intentional overlap is allowed only when a text/control belongs visually on a card.",
  "Use Inter as fontFamily and Regular as fontStyle. Give visual hierarchy through font size, spacing, type scale, alignment, cards, and restrained color. Keep text short enough to fit its boxes. Use strong contrast and consistent spacing.",
  "Preserve the source screen's user intent, content taxonomy, and brand tone when a selected design exists, but produce a genuinely improved variation instead of copying its layout mechanically. Keep the source untouched.",
  "For Indian BFSI designs, emphasize transparency, clear amount/date/status hierarchy, user control and accessible legibility. Never make up actual interest rates, contractual terms, or legal-compliance claims. Label illustrative financial values as sample.",
  "Keep all elements within frame bounds, use reasonable minimum touch targets for CTAs, and include the primary action and meaningful secondary paths where appropriate. Limit to 80 elements and use only supported properties.",
  "Return a concise user-facing summary of what you designed, not hidden reasoning."
].join("\n");

function extractJson(content: unknown): unknown {
  if (typeof content !== "string") return null;
  const cleaned = content.trim().replace(/^\uFEFF/, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { return null; }
}

export async function OPTIONS(request: Request) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(request) });
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  const headers = cors(request);
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return NextResponse.json({ error: "OpenRouter is not configured on the UX Direct Worker." }, { status: 503, headers });

  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers }); }
  const requestSchema = z.object({
    prompt: z.string().trim().min(2).max(5000),
    canvas: z.unknown(),
  }).strict();
  const parsedInput = requestSchema.safeParse(input);
  if (!parsedInput.success) return NextResponse.json({ error: "A prompt and canvas context are required.", details: parsedInput.error.issues }, { status: 400, headers });
  const canvas = compactCanvas(parsedInput.data.canvas);
  const userContext = JSON.stringify({ prompt: parsedInput.data.prompt, figmaCanvas: canvas });
  if (userContext.length > 52000) return NextResponse.json({ error: "Selection context is too large. Select a smaller frame or reduce the number of layers." }, { status: 413, headers });

  let brain: BrainContextPromptInput = { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: 0 };
  const brainStarted = Date.now();
  try {
    const retrieved = await retrieveBrainContext({
      query: (parsedInput.data.prompt + "\n" + JSON.stringify(canvas).slice(0, 1800)).slice(0, 3000),
      scopeKeys: resolveBrainScopes(parsedInput.data.prompt + "\n" + JSON.stringify(canvas.nodes).slice(0, 1500)),
      limit: 5,
      maxChars: 4200,
      includeKnowledge: true,
    });
    brain = {
      contextText: retrieved.contextText.slice(0, 5200),
      status: retrieved.retrieval.status,
      memoryCount: Math.max(0, retrieved.retrieval.memoryCount || 0),
      knowledgeChunkCount: Math.max(0, retrieved.retrieval.knowledgeChunkCount || 0),
      durationMs: Date.now() - brainStarted,
    };
  } catch {
    brain = { contextText: "", status: "degraded", memoryCount: 0, knowledgeChunkCount: 0, durationMs: Date.now() - brainStarted };
  }

  const system = buildBrainSystemPrompt(SYSTEM, brain);
  const endpoint = ((process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "")) + "/chat/completions";
  const configured = (process.env.UXD_FIGMA_AGENT_MODELS || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 3);
  const models = [...new Set(["openrouter/auto", ...configured])].slice(0, 3);
  const errors: string[] = [];
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Accept: "application/json",
          "HTTP-Referer": new URL(request.url).origin,
          "X-OpenRouter-Title": "UX Direct Figma Agent",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: "Build the requested design variation. Use the supplied canvas tree as the source of truth. The user request and selected frame context are below:\n" + userContext },
          ],
          temperature: 0.25,
          max_tokens: 8500,
          response_format: { type: "json_object" },
          ...(model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}),
          provider: { sort: "throughput" },
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      const rawPayload: unknown = await response.json().catch(() => null);
      const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? rawPayload as Record<string, unknown>
        : {};
      const providerError = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
        ? payload.error as Record<string, unknown>
        : {};
      if (!response.ok) {
        const detail = typeof providerError.message === "string" ? providerError.message.slice(0, 260) : "HTTP " + response.status;
        errors.push(model + ": " + detail);
        continue;
      }
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0])
        ? choices[0] as Record<string, unknown>
        : {};
      const providerMessage = firstChoice.message && typeof firstChoice.message === "object" && !Array.isArray(firstChoice.message)
        ? firstChoice.message as Record<string, unknown>
        : {};
      const parsedPlan = PlanSchema.safeParse(extractJson(providerMessage.content));
      if (!parsedPlan.success) {
        errors.push(model + ": invalid design plan schema (" + parsedPlan.error.issues.slice(0, 3).map((issue) => issue.path.join(".") + " " + issue.message).join("; ") + ")");
        continue;
      }
      return NextResponse.json({
        ok: true,
        plan: parsedPlan.data,
        model: typeof payload.model === "string" ? payload.model : model,
        brain: { status: brain.status, memories: brain.memoryCount, knowledgeChunks: brain.knowledgeChunkCount, latencyMs: brain.durationMs },
      }, { headers });
    } catch (error) {
      errors.push(model + ": " + (controller.signal.aborted ? "timed out after 65 seconds" : error instanceof Error ? error.message.slice(0, 200) : "request failed"));
    } finally {
      clearTimeout(timer);
    }
  }
  return NextResponse.json({
    error: "UX Direct could not produce a valid native Figma design plan. No canvas changes were made.",
    attemptedModels: models,
    details: errors.slice(0, 3),
  }, { status: 502, headers });
}
