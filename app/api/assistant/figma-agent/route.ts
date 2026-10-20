import { NextResponse } from "next/server";
import { z } from "zod";
import { buildBrainSystemPrompt, resolveBrainScopes, type BrainContextPromptInput } from "@/src/memory/chat-context";
import { retrieveBrainContext } from "@/src/memory/shared-brain";
import { normalizePlan } from "@/src/figma-agent/normalize-plan";

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

const ElementFieldsSchema = z.object({
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
  noFill: z.boolean().optional(),
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
});
const ElementSchema: z.ZodTypeAny = z.lazy(() =>
  ElementFieldsSchema.extend({ children: z.array(ElementSchema).max(80).optional() })
    .strict()
    .superRefine((item, ctx) => {
      if (item.type === "TEXT" && typeof item.text !== "string") {
        ctx.addIssue({ code: "custom", path: ["text"], message: "TEXT elements require text." });
      }
      if (Array.isArray(item.children) && item.children.length && item.type !== "FRAME") {
        ctx.addIssue({ code: "custom", path: ["children"], message: "Only FRAME elements may contain nested children." });
      }
      if (item.noFill === true && item.type !== "FRAME") {
        ctx.addIssue({ code: "custom", path: ["noFill"], message: "noFill is supported only for FRAME containers." });
      }
    })
);
const PlanSchema = z.object({
  summary: z.string().trim().min(8).max(700),
  frame: z.object({
    name: z.string().trim().min(1).max(80),
    width: z.number().int().min(280).max(1440),
    height: z.number().int().min(360).max(4096),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }).strict(),
  elements: z.array(ElementSchema).min(5).max(12),
}).strict().superRefine((plan, ctx) => {
  let totalNodes = 0;
  let namedContainers = 0;
  let invalidChildType = false;
  const count = (nodes: unknown[]) => {
    for (const value of nodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Record<string, unknown>;
      totalNodes += 1;
      const children = Array.isArray(node.children) ? node.children : [];
      if (node.type === "FRAME" && children.length > 0) namedContainers += 1;
      if (children.length > 0 && node.type !== "FRAME") invalidChildType = true;
      count(children);
    }
  };
  count(plan.elements as unknown[]);
  if (plan.elements.some((element: any) => element.type !== "FRAME")) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Top-level design sections must be named FRAME containers." });
  }
  if (namedContainers < 4) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Use at least four meaningful FRAME containers with nested native layers." });
  }
  if (totalNodes < 18) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design hierarchy is too sparse; include enough native components and content layers." });
  }
  if (totalNodes > 80) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design exceeds the safe 80-node budget." });
  }
  if (invalidChildType) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Nested children must belong to FRAME containers." });
  }
});

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
  "Return ONLY one JSON object. Root keys: summary (string), frame ({name,width,height,backgroundColor}), elements (5–12 top-level FRAME section containers and 18–80 native nodes total). Each node MUST include type, name, x, y, width, height. Allowed type values: RECTANGLE, ELLIPSE, TEXT, LINE, FRAME, POLYGON, STAR. Use color: \"#RRGGBB\" for fill, NOT a fill key. TEXT layers must include text. FRAME nodes may include a children array recursively; only FRAME can contain children. Use noFill:true for transparent structural wrappers, but use visibly styled FRAMEs for cards/surfaces. Do not flatten everything into direct layers. Do not use markdown fences.",
  "Analyse BOTH the attached rendered screen image and native layer tree before planning. Use the image to understand visual hierarchy, alignment, density, spacing, contrast, components, states and design language; use the layer tree for exact text, names, geometry, typography and paint values.",
  "Do not replace an existing task-specific screen with a generic dashboard, generic landing page, or repeated stack of similar cards. Preserve the selected screen's purpose, key content, taxonomy and useful visual patterns. Reuse its components when possible, then improve professional craft, consistency, readability, alignment, action priority and visual rhythm.",
  "Prefer evidence-grounded product content and component patterns. If values are unknown, label financial amounts as sample. Never claim visual analysis when no image was supplied.",
  "Create a polished, high-fidelity native Figma screen using only native shapes and text layers. Do not use images, external assets, or invented APIs.",
  "Use a real Figma layer tree: Screen -> named sections/cards (FRAME) -> related controls/content/text. Create 5–8 meaningful top-level FRAME sections with distinct names such as Header & navigation, Status tabs, Primary summary, Detail breakdown, Actions and Support. Nest each card's background, labels, values, badges, dividers and actions inside that card's FRAME. Nest the heading/icon inside header frames and tab labels/active underline inside the tabs frame. Use at least 3 hierarchy levels where the content warrants them. The output should be easy to inspect in Figma's layers panel, not a pile of siblings.",
  "Coordinates are relative to each immediate parent frame's top-left, not global screen coordinates. Each frame's child x/y must fall inside that frame; draw rectangles/backplates before their text/icons. Give sections sensible heights and distinct y positions so nothing stacks at the top or overlaps accidentally. Use noFill:true for grouping frames that should not paint over their children; styled card frames should have their own background, corner radius and optional subtle stroke/shadow.",
  "For a mobile 360×800 design, use consistent 16–24 px side margins, a deliberate vertical rhythm, a clear type scale (screen title 22–26, section headings 17–20, key amounts 24–30, body 13–16, muted metadata 11–13), high contrast, and visible space between sections. Match the selected screen's visual system and information density rather than inventing a new generic template. Do not fill empty space with random cards.",
  "Use Inter as fontFamily and Regular or Medium as fontStyle when available. Define a coherent spacing scale, typography scale, surface palette and accent usage from the source screenshot/layers. For dark screens, retain the dark canvas and source's card/surface contrast; don't put a single grey slab in an otherwise black screen. Use moderate, consistent corner radii, separator lines only where useful, and strong text contrast. Keep copy and visible values faithful to the selection; never invent features just to decorate a screen.",
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
    renderedScreen: z.string().max(52000).nullable().optional(),
    visualCaptureWarning: z.string().max(400).optional(),
  }).strict();
  const parsedInput = requestSchema.safeParse(input);
  if (!parsedInput.success) return NextResponse.json({ error: "Invalid Figma agent request.", details: parsedInput.error.issues.map((issue) => (issue.path.length ? issue.path.join(".") + ": " : "request: ") + issue.message) }, { status: 400, headers });
  const renderedScreen = typeof parsedInput.data.renderedScreen === "string" &&
    parsedInput.data.renderedScreen.length <= 52000 &&
    new RegExp("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$").test(parsedInput.data.renderedScreen)
    ? parsedInput.data.renderedScreen : null;
  const canvas = compactCanvas(parsedInput.data.canvas);
  const userContext = JSON.stringify({
    prompt: parsedInput.data.prompt,
    figmaCanvas: canvas,
    visualCapture: renderedScreen ? "Rendered selected-screen image is attached." :
      parsedInput.data.visualCaptureWarning || "No rendered image available; analyse layer evidence only and do not claim visual inspection.",
  });
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
  // User-selected model order: Luna first, OpenRouter Auto as the explicit fallback.
  const models = ["openai/gpt-6-luna", "openrouter/auto"];
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
            { role: "user", content: renderedScreen
              ? [
                  { type: "text", text: "Design a high-fidelity, source-faithful improvement. Combine the rendered screen image with its native layer tree. Avoid generic redesigns. Context:\n" + userContext },
                  { type: "image_url", image_url: { url: renderedScreen } },
                ]
              : "Design a source-faithful improvement using native layer evidence only. No rendered image was available, so do not claim visual inspection. Context:\n" + userContext },
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
      const rawPlan = extractJson(providerMessage.content);
      const normalizedPlan = normalizePlan(rawPlan, canvas);
      const parsedPlan = PlanSchema.safeParse(normalizedPlan);
      if (!parsedPlan.success) {
        errors.push(model + ": invalid design plan schema (" + parsedPlan.error.issues.slice(0, 3).map((issue) => issue.path.join(".") + " " + issue.message).join("; ") + ")");
        continue;
      }
      return NextResponse.json({
        ok: true,
        plan: parsedPlan.data,
        model: typeof payload.model === "string" ? payload.model : model,
        brain: { status: brain.status, memories: brain.memoryCount, knowledgeChunks: brain.knowledgeChunkCount, latencyMs: brain.durationMs },
        visualAnalysis: { imageReceived: !!renderedScreen, layerNodeCount: canvas.nodeCount, warning: parsedInput.data.visualCaptureWarning || null },
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
