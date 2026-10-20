import { NextResponse } from "next/server";
import { z } from "zod";
import { buildBrainSystemPrompt, resolveBrainScopes, type BrainContextPromptInput } from "@/src/memory/chat-context";
import { retrieveBrainContext } from "@/src/memory/shared-brain";
import { captureFigmaTaskLearning } from "@/src/memory/task-learning";
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
  if (plan.elements.some((element) => (element as Record<string, unknown>).type !== "FRAME")) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Top-level design sections must be named FRAME containers." });
  }
  if (namedContainers < 4) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Use at least four meaningful FRAME containers with nested native layers." });
  }
  if (totalNodes < 18) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design hierarchy is too sparse; include enough native components and content layers." });
  }
  const textNodes: Record<string, unknown>[] = [];
  const repeatedText = new Map<string, number>();
  const visitQuality = (nodes: unknown[]) => {
    for (const value of nodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Record<string, unknown>;
      if (node.type === "TEXT") {
        const text = typeof node.text === "string" ? node.text.trim() : "";
        textNodes.push(node);
        if (text) repeatedText.set(text.toLowerCase(), (repeatedText.get(text.toLowerCase()) || 0) + 1);
      }
      visitQuality(Array.isArray(node.children) ? node.children : []);
    }
  };
  visitQuality(plan.elements as unknown[]);
  const meaningfulText = textNodes.filter(node => typeof node.text === "string" &&
    String(node.text).trim().length >= 2 &&
    !/^(rectangle|frame|text|ellipse|line|container|section|placeholder|sample text)$/i.test(String(node.text).trim()));
  if (textNodes.length < 6 || meaningfulText.length < 5) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design needs more meaningful native text content; placeholders or mostly decorative shapes are not sufficient." });
  }
  const decorativeDominance = totalNodes > 0 && textNodes.length / totalNodes < 0.22;
  if (decorativeDominance) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "Design is too shape-heavy relative to its meaningful content. Add labels, values, and task-specific detail." });
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
  "You are UX Direct's senior product designer and expert native Figma designer. Users should be able to type a short request such as 'Create a variation with better hierarchy and spacing'. The short request expresses the desired change; it is NOT expected to contain the procedure. Execute the entire built-in design playbook automatically without asking the user to repeat it.",
  "Determine the scope from the selected node. If the selected node is a card, component, widget, row, or other sub-screen component, create a variation of that component only and keep its content inside that component's dimensions. Do not invent screen navigation, unrelated sections, or full-screen chrome for a component selection. If the selected node is a complete screen, create a screen variation.",
  "Before designing, extract a preservation inventory from the selected layer tree: every meaningful label, value, amount, date, status, indicator, icon role, repeated row, action, and relationship. Keep each item unless the user's requested change explicitly removes or changes it. If something is not legible in the screenshot, trust exact source text in the layer tree.",
  "Use native Figma layout, not just visual approximation. Where appropriate set FRAME layoutMode to VERTICAL or HORIZONTAL and define padding, itemSpacing, alignment and sizing. Use Auto Layout for card content, stacks, tab rows, repeated information rows and action groups when suitable; use absolute positioning only for overlays, decorative elements or intentional placements. Do not claim Auto Layout or reusable components unless the resulting properties/nodes confirm them.",
  "A short prompt must be mapped to a concrete design objective. Keep everything else stable: product context, information architecture, content, interaction meaning and source visual language. Make deliberate, restrained improvements; do not simplify away meaningful content merely to make the canvas look cleaner.",
  "You are UX Direct's native Figma design agent. The user explicitly requested a design action.",
  "Return ONLY one JSON object. Required root keys: summary (string), frame ({name,width,height,backgroundColor}), elements (5–12 top-level FRAME section containers and 18–80 native nodes total). Optional root key learningCandidate: null or {activate:true,title,normalizedRule,rationale,scopeKey,feedbackKind,keywords,originalLanguage}; include it only if this task produced one durable reusable design or execution lesson, never as a task summary. Do not include client-specific names in cross-user or domain-wide rules, raw requirements, screen text, node IDs, screenshots or private facts. Use the narrowest safe scope; the backend validates, scopes, deduplicates and applies the existing 50% relevance threshold. Each node MUST include type, name, x, y, width, height. Allowed type values: RECTANGLE, ELLIPSE, TEXT, LINE, FRAME, POLYGON, STAR. Use color: \"#RRGGBB\" for fill, NOT a fill key. TEXT layers must include text. FRAME nodes may include a children array recursively; only FRAME can contain children. Use noFill:true for transparent structural wrappers, but use visibly styled FRAMEs for cards/surfaces. Do not flatten everything into direct layers. Do not use markdown fences.",
  "Analyse BOTH the attached rendered screen image and native layer tree before planning. Use the image to understand visual hierarchy, alignment, density, spacing, contrast, components, states and design language; use the layer tree for exact text, names, geometry, typography and paint values.",
  "Do not replace an existing task-specific screen with a generic dashboard, generic landing page, or repeated stack of similar cards. Preserve the selected screen's purpose, key content, taxonomy and useful visual patterns. Reuse its components when possible, then improve professional craft, consistency, readability, alignment, action priority and visual rhythm.",
  "Prefer evidence-grounded product content and component patterns. If values are unknown, label financial amounts as sample. Never claim visual analysis when no image was supplied.",
  "Create a polished, high-fidelity native Figma screen using only native shapes and text layers. Do not use images, external assets, or invented APIs.",
  "Use a real Figma layer tree appropriate to selection scope: for a full screen, create meaningful screen sections; for a component, create meaningful internal groups such as Header & status, Primary information, Supporting detail, Progress/indicators and Actions only when those concepts exist in the source. Create 5–8 suitable top-level FRAME groups with names that describe their actual contents, not boilerplate section names. Nest each card's background, labels, values, badges, dividers and actions inside that card's FRAME. Nest row labels and figures together. Use 3 hierarchy levels where the content warrants them, never create empty wrappers just to meet a count. The output should be easy to inspect in Figma's layers panel, not a pile of siblings.",
  "Coordinates are relative to each immediate parent frame's top-left, not global screen coordinates. Each frame's child x/y must fall inside that frame; draw rectangles/backplates before their text/icons. Give sections sensible heights and distinct y positions so nothing stacks at the top or overlaps accidentally. With Auto Layout enabled, rely on flow order, padding, spacing and alignment rather than simulated absolute positions. Use noFill:true for transparent structural wrappers; styled card frames should have their own background, corner radius and optional subtle stroke/shadow. Do not add a giant empty background inside a small selected card.",
  "For a mobile 360×800 design, use consistent 16–24 px side margins, a deliberate vertical rhythm, a clear type scale (screen title 22–26, section headings 17–20, key amounts 24–30, body 13–16, muted metadata 11–13), high contrast, and visible space between sections. Match the selected screen's visual system and information density rather than inventing a new generic template. Do not fill empty space with random cards.",
  "Use Inter as fontFamily and Regular or Medium as fontStyle when available. Define a coherent spacing scale, typography scale, surface palette and accent usage from the source screenshot/layers. For dark screens, retain the dark canvas and source's card/surface contrast; don't put a single grey slab in an otherwise black screen. Use moderate, consistent corner radii, separator lines only where useful, and strong text contrast. Keep copy and visible values faithful to the selection; never invent features just to decorate a screen.",
  "Preserve the source's user intent, content taxonomy, and brand tone while producing a genuinely improved variation rather than copying its layout mechanically. Preserve every visible meaningful datum and repeated row. Use the selected frame's actual scope and size. Keep the source untouched.",
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
  const selectedRoot = Array.isArray(canvas.nodes) && canvas.nodes[0] && typeof canvas.nodes[0] === "object"
    ? canvas.nodes[0] as Record<string, unknown> : {};
  const selectedName = typeof selectedRoot.name === "string" ? selectedRoot.name : "";
  const selectedType = typeof selectedRoot.type === "string" ? selectedRoot.type.toUpperCase() : "";
  const selectedWidth = typeof selectedRoot.width === "number" ? selectedRoot.width : 0;
  const selectedHeight = typeof selectedRoot.height === "number" ? selectedRoot.height : 0;
  const componentSelection = ["COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(selectedType) ||
    (selectedWidth > 0 && selectedWidth <= 520 && selectedHeight > 0 && selectedHeight <= 560 &&
      /\b(card|component|widget|tile|row|button|panel|item|summary|breakdown|loan)\b/i.test(selectedName) &&
      !/\b(screen|page|dashboard|flow)\b/i.test(selectedName));
  const designScope = componentSelection ? "selected_component_or_card" : "selected_screen_or_frame";
  const userContext = JSON.stringify({
    prompt: parsedInput.data.prompt,
    designScope,
    selectedNode: { name: selectedName, type: selectedType, width: selectedWidth, height: selectedHeight },
    operatingContract: [
      "Treat the user's short prompt as the requested design change, not as the full procedure. Apply the built-in senior designer and expert Figma workflow automatically.",
      "Inventory and preserve all meaningful source text, labels, values, amounts, dates, statuses, indicators, icons, repeated rows, and relationships unless the user explicitly asks to change them.",
      "Use both the rendered screenshot (when available) and native layer tree to infer visual style, layout, information hierarchy, reusable patterns, and content density before planning.",
      "Translate only the requested improvement into a meaningful variation; preserve the source product identity and do not replace specific UI with generic cards.",
      "Build editable semantic FRAME containers with logically nested layers. Use Auto Layout on suitable vertical stacks, horizontal rows, cards and repeated groups; set layoutMode, padding, itemSpacing and alignment deliberately. Use absolute coordinates only where appropriate.",
      "Render, inspect, refine actionable defects, and verify the actual native hierarchy. Report unavailable visual checks honestly."
    ],
    visualCapture: renderedScreen ? "Rendered selected-node image is attached." :
      parsedInput.data.visualCaptureWarning || "No rendered image available; use native layer evidence and do not claim visual inspection.",
    figmaCanvas: canvas,
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

  const scopeInstructions = componentSelection
    ? "TARGET SCOPE: COMPONENT/CARD. The selected source is " + selectedName + " at " + selectedWidth + "×" + selectedHeight + ". Create only a high-quality component variation, preserving all source data and relationships. Prefer card header, status badge, key values, progress indicator, secondary rows and actions when these exist. Use nested card/row FRAMEs and appropriate Auto Layout; no whole-screen navbar or unrelated screen sections."
    : "TARGET SCOPE: FULL SCREEN/FRAME. Preserve the screen's information architecture and complete content inventory. Structure navigation, tabs, summary cards, repeated rows, supporting detail and actions in meaningful native FRAMEs with suitable Auto Layout.";
  const system = buildBrainSystemPrompt(SYSTEM + "\n" + scopeInstructions, brain);
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
      const rawPlanRecord = rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
        ? rawPlan as Record<string, unknown> : {};
      const normalizedPlan = normalizePlan(rawPlan, canvas);
      const parsedPlan = PlanSchema.safeParse(normalizedPlan);
      if (!parsedPlan.success) {
        errors.push(model + ": invalid design plan schema (" + parsedPlan.error.issues.slice(0, 3).map((issue) => issue.path.join(".") + " " + issue.message).join("; ") + ")");
        continue;
      }
      const learningStatus = await captureFigmaTaskLearning(
        rawPlanRecord.learningCandidate,
        parsedInput.data.prompt,
        "automatic-figma-generation",
      );
      return NextResponse.json({
        ok: true,
        plan: parsedPlan.data,
        learning: learningStatus,
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
