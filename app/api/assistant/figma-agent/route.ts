import { NextResponse } from "next/server";
import { z } from "zod";
import { buildBrainSystemPrompt, resolveBrainScopes, type BrainContextPromptInput } from "@/src/memory/chat-context";
import { retrieveBrainContext } from "@/src/memory/shared-brain";
import { captureFigmaTaskLearning } from "@/src/memory/task-learning";
import { FIGMA_AGENT_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";
import { normalizePlan } from "@/src/figma-agent/normalize-plan";
import { describeModelContent, extractPlanJson } from "@/src/figma-agent/extract-plan-json";

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
  paintStyleId: z.string().trim().min(1).max(300).optional(),
  textStyleId: z.string().trim().min(1).max(300).optional(),
  effectStyleId: z.string().trim().min(1).max(300).optional(),
  gridStyleId: z.string().trim().min(1).max(300).optional(),
  noFill: z.boolean().optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(20).optional(),
  arcData: z.object({
    startingAngle: z.number().finite().min(-6.283185307179586).max(6.283185307179586),
    endingAngle: z.number().finite().min(-6.283185307179586).max(6.283185307179586),
    innerRadius: z.number().finite().min(0).max(1),
  }).strict().optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  cornerRadius: z.number().finite().min(0).max(128).optional(),
  clipsContent: z.boolean().optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
  layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
  layoutGrow: z.number().finite().min(0).max(1).optional(),
  horizontalConstraint: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  verticalConstraint: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
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
  lineHeight: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(1).max(500) }).strict().optional(),
  letterSpacing: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(-100).max(500) }).strict().optional(),
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
      if (item.arcData !== undefined && item.type !== "ELLIPSE") {
        ctx.addIssue({ code: "custom", path: ["arcData"], message: "arcData is supported only on ELLIPSE nodes." });
      }
      if (item.arcData && item.arcData.endingAngle <= item.arcData.startingAngle) {
        ctx.addIssue({ code: "custom", path: ["arcData", "endingAngle"], message: "endingAngle must be greater than startingAngle." });
      }
      if (item.layoutMode !== undefined && item.type !== "FRAME") {
        ctx.addIssue({ code: "custom", path: ["layoutMode"], message: "Auto Layout container properties belong on FRAME elements." });
      }
      if (item.layoutWrap !== undefined && item.layoutMode !== "HORIZONTAL") {
        ctx.addIssue({ code: "custom", path: ["layoutWrap"], message: "Wrap is supported only on horizontal Auto Layout frames." });
      }
      if ((item.horizontalConstraint !== undefined || item.verticalConstraint !== undefined) && item.layoutPositioning !== "ABSOLUTE") {
        ctx.addIssue({ code: "custom", path: ["layoutPositioning"], message: "Responsive constraints are for intentionally positioned children; set layoutPositioning to ABSOLUTE." });
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
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
    itemSpacing: z.number().finite().min(0).max(160),
    paddingLeft: z.number().finite().min(0).max(160),
    paddingRight: z.number().finite().min(0).max(160),
    paddingTop: z.number().finite().min(0).max(160),
    paddingBottom: z.number().finite().min(0).max(160),
    primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]),
    primaryAxisSizingMode: z.enum(["AUTO", "FIXED"]),
    counterAxisSizingMode: z.enum(["AUTO", "FIXED"]),
  }).strict(),
  elements: z.array(ElementSchema).min(3).max(8),
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
  fillColors?: string[]; visible?: boolean; layoutMode?: string; layoutWrap?: string;
  layoutSizingHorizontal?: string; layoutSizingVertical?: string; layoutPositioning?: string;
  primaryAxisSizingMode?: string; counterAxisSizingMode?: string; itemSpacing?: number;
  paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  primaryAxisAlignItems?: string; counterAxisAlignItems?: string; textAutoResize?: string;
  horizontalConstraint?: string; verticalConstraint?: string;
  childCount?: number; children?: CanvasNode[];
};
function compactNode(value: unknown, state: { count: number }, depth = 0): CanvasNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || state.count >= 100) return null;
  const node = value as Record<string, unknown>;
  if (typeof node.name !== "string" || typeof node.type !== "string") return null;
  state.count += 1;
  const out: CanvasNode = { name: node.name.slice(0, 120), type: node.type.slice(0, 40) };
  for (const key of [
    "id", "x", "y", "width", "height", "text", "fontSize", "visible", "layoutMode", "layoutWrap",
    "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisSizingMode",
    "counterAxisSizingMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
    "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize", "horizontalConstraint", "verticalConstraint",
    "childCount",
  ] as const) {
    const valueAtKey = node[key];
    if (key === "id" && typeof valueAtKey === "string") out.id = valueAtKey.slice(0, 100);
    if (["x", "y", "width", "height", "fontSize", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "childCount"].includes(key) && typeof valueAtKey === "number" && Number.isFinite(valueAtKey)) (out as unknown as Record<string, unknown>)[key] = valueAtKey;
    if (key === "text" && typeof valueAtKey === "string") out.text = valueAtKey.slice(0, 350);
    if (key === "visible" && typeof valueAtKey === "boolean") out.visible = valueAtKey;
    if (["layoutMode", "layoutWrap", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize", "horizontalConstraint", "verticalConstraint"].includes(key) && typeof valueAtKey === "string") (out as unknown as Record<string, unknown>)[key] = valueAtKey.slice(0, 20);
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
function compactRecoveryNode(
  value: unknown,
  state: { count: number },
  depth = 0,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3 || state.count >= 45) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.type !== "string") return null;
  state.count += 1;
  const out: Record<string, unknown> = { type: source.type };
  for (const key of [
    "id", "name", "text", "x", "y", "width", "height", "fontSize", "layoutMode", "layoutWrap",
    "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "primaryAxisSizingMode",
    "counterAxisSizingMode", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
    "primaryAxisAlignItems", "counterAxisAlignItems", "textAutoResize", "horizontalConstraint", "verticalConstraint",
    "childCount",
  ] as const) {
    const raw = source[key];
    if (typeof raw === "string") out[key] = raw.slice(0, key === "text" ? 140 : 80);
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  if (Array.isArray(source.fillColors)) out.fillColors = source.fillColors.filter((item): item is string => typeof item === "string").slice(0, 2);
  if (Array.isArray(source.children) && depth < 3) {
    const children: Record<string, unknown>[] = [];
    for (const child of source.children.slice(0, 8)) {
      const nested = compactRecoveryNode(child, state, depth + 1);
      if (nested) children.push(nested);
      if (state.count >= 45) break;
    }
    if (children.length) out.children = children;
  }
  return out;
}

function compactRecoveryCanvas(canvas: Record<string, unknown>): Record<string, unknown> {
  const state = { count: 0 };
  const sourceNodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const nodes = sourceNodes.slice(0, 8)
    .map((node) => compactRecoveryNode(node, state))
    .filter((node): node is Record<string, unknown> => !!node);
  return {
    pageName: typeof canvas.pageName === "string" ? canvas.pageName.slice(0, 80) : "",
    scope: typeof canvas.scope === "string" ? canvas.scope.slice(0, 30) : "selection",
    nodes,
  };
}

function compactResourceList(value: unknown, limit = 50): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [{ id: item.id.slice(0, 300), name: item.name.slice(0, 120),
      ...(typeof item.type === "string" ? { type: item.type.slice(0, 40) } : {}),
      ...(typeof item.collectionName === "string" ? { collectionName: item.collectionName.slice(0, 100) } : {}),
      ...(typeof item.collectionId === "string" ? { collectionId: item.collectionId.slice(0, 300) } : {}) }];
  });
}
function compactCanvas(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { pageName: "Unknown page", nodes: [] };
  const canvas = value as Record<string, unknown>;
  const state = { count: 0 };
  const nodes = Array.isArray(canvas.nodes)
    ? canvas.nodes.slice(0, 20).map((node) => compactNode(node, state)).filter((node): node is CanvasNode => !!node)
    : [];
  const rawStyles = canvas.styles && typeof canvas.styles === "object" && !Array.isArray(canvas.styles) ? canvas.styles as Record<string, unknown> : {};
  const styles = { paint: compactResourceList(rawStyles.paint), text: compactResourceList(rawStyles.text),
    effect: compactResourceList(rawStyles.effect), grid: compactResourceList(rawStyles.grid) };
  const variableCollections = Array.isArray(canvas.variableCollections) ? canvas.variableCollections.slice(0, 30).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    return [{ id: item.id.slice(0, 300), name: item.name.slice(0, 100),
      modes: Array.isArray(item.modes) ? item.modes.slice(0, 8).flatMap((mode) => {
        if (!mode || typeof mode !== "object" || Array.isArray(mode)) return [];
        const data = mode as Record<string, unknown>;
        return typeof data.modeId === "string" && typeof data.name === "string"
          ? [{ modeId: data.modeId.slice(0, 100), name: data.name.slice(0, 100) }] : [];
      }) : [] }];
  }) : [];
  return { pageName: typeof canvas.pageName === "string" ? canvas.pageName.slice(0, 120) : "Unknown page",
    scope: typeof canvas.scope === "string" ? canvas.scope.slice(0, 40) : "selection",
    nodeCount: state.count, truncated: canvas.truncated === true || state.count >= 100, nodes,
    viewport: canvas.viewport && typeof canvas.viewport === "object" ? canvas.viewport : undefined,
    styles, variableCollections, variables: compactResourceList(canvas.variables, 120) };
}

const SYSTEM = [
  UX_DIRECT_DESIGN_ROLE + " Users can give a short request. Infer the design procedure and execute the full playbook automatically without asking them to repeat it.",
  "Determine the scope from the selected node. If the selected node is a card, component, widget, row, or other sub-screen component, create a variation of that component only and keep its content inside that component's dimensions. Do not invent screen navigation, unrelated sections, or full-screen chrome for a component selection. If the selected node is a complete screen, create a screen variation.",
  "Before designing, extract a preservation inventory from the selected layer tree: every meaningful label, value, amount, date, status, indicator, icon role, repeated row, action, and relationship. Keep each item unless the user's requested change explicitly removes or changes it. If something is not legible in the screenshot, trust exact source text in the layer tree.",
  "Use actual native Figma Auto Layout, not merely an arrangement that resembles it. Set FRAME.layoutMode to VERTICAL for content stacks/cards, HORIZONTAL for tabs, inline metric rows and action bars. Set itemSpacing, four padding values, primary/counter alignment, and axis sizing. For direct children of Auto Layout parents use layoutSizingHorizontal/layoutSizingVertical = HUG, FILL or FIXED intentionally; ordinary text in vertical stacks normally FILLs width and uses textAutoResize=HEIGHT. Use layoutPositioning=ABSOLUTE only for real overlays (status badges, progress-labels over rings, backplates, decorative art); preserve their coordinates. In an Auto Layout parent, child order is the flow order and x/y is ignored for AUTO-positioned children. Do not claim a feature unless the read-back shows its native properties.",
  "A short prompt must be mapped to a concrete design objective. Keep everything else stable: product context, information architecture, content, interaction meaning and source visual language. Make deliberate, restrained improvements; do not simplify away meaningful content merely to make the canvas look cleaner.",
  "You are UX Direct's native Figma design agent. The user explicitly requested a design action.",
  "Return ONLY one JSON object. Required root keys: summary (string), frame ({name,width,height,backgroundColor}), elements (3–8 meaningful top-level FRAME section containers and 18–80 native nodes total). Optional root key learningCandidate: null or {activate:true,title,normalizedRule,rationale,scopeKey,feedbackKind,keywords,originalLanguage}; include it only if this task produced one durable reusable design or execution lesson, never as a task summary. Do not include client-specific names in cross-user or domain-wide rules, raw requirements, screen text, node IDs, screenshots or private facts. Use the narrowest safe scope; the backend validates, scopes, deduplicates and applies the existing 50% relevance threshold. Each node MUST include type, name, x, y, width, height. Allowed type values: RECTANGLE, ELLIPSE, TEXT, LINE, FRAME, POLYGON, STAR. ELLIPSE may use arcData:{startingAngle,endingAngle,innerRadius} with radian angles and endingAngle > startingAngle for native progress arcs/rings. Use color: \"#RRGGBB\" for fill, NOT a fill key. TEXT layers must include text. FRAME nodes may include a children array recursively; only FRAME can contain children. Use noFill:true for transparent structural wrappers, but use visibly styled FRAMEs for cards/surfaces. Do not flatten everything into direct layers. Do not use markdown fences.",
  "Analyse BOTH the attached rendered screen image and native layer tree before planning. Use the image to understand visual hierarchy, alignment, density, spacing, contrast, components, states and design language; use the layer tree for exact text, names, geometry, typography and paint values.",
  "Do not replace an existing task-specific screen with a generic dashboard, generic landing page, or repeated stack of similar cards. Preserve the selected screen's purpose, key content, taxonomy and useful visual patterns. Reuse its components when possible, then improve professional craft, consistency, readability, alignment, action priority and visual rhythm.",
  "Prefer evidence-grounded product content and component patterns. If values are unknown, label financial amounts as sample. Never claim visual analysis when no image was supplied.",
  "Create a polished, high-fidelity native Figma screen using only native shapes and text layers. Do not use images, external assets, or invented APIs.",
  "Use a real Figma layer tree appropriate to selection scope: for a full screen, create meaningful screen sections; for a component, create meaningful internal groups such as Header & status, Primary information, Supporting detail, Progress/indicators and Actions only when those concepts exist in the source. Create 3–6 suitable top-level FRAME groups with names that describe their actual contents, not boilerplate section names. If the source has one enclosing card containing a summary and a breakdown, keep both within one styled outer card FRAME and use an inner divider or surface split. Keep status badges and overlays nested with the card they belong to. Nest row labels and figures together. Use 3 hierarchy levels where the content warrants them; never create empty wrappers just to meet a count. The output should be easy to inspect in Figma's layers panel, not a pile of siblings.",
  "Coordinates are relative to each immediate parent frame's top-left, not global screen coordinates. Auto Layout children flow in array order; do not emit different content nodes at the same simulated coordinates as a substitute for layout. Use layoutSizingHorizontal and layoutSizingVertical explicitly on children of Auto Layout frames. Use layoutPositioning=ABSOLUTE plus x/y only for overlays. Draw backplates behind the content and mark the backplate ABSOLUTE inside an Auto Layout container. Use noFill:true for transparent structural wrappers; styled card frames should have their own background, corner radius and optional subtle stroke/shadow. Do not add a giant empty background inside a small selected card.",
  "For a mobile 360×800 design, use consistent 16–24 px side margins, a deliberate vertical rhythm, a clear type scale (screen title 22–26, section headings 17–20, key amounts 24–30, body 13–16, muted metadata 11–13), high contrast, and visible space between sections. Match the selected screen's visual system and information density rather than inventing a new generic template. Do not fill empty space with random cards.",
  "Use Inter as fontFamily and Regular or Medium as fontStyle when available. Define a coherent spacing scale, typography scale, surface palette and accent usage from the source screenshot/layers. For dark screens, retain the dark canvas and source's card/surface contrast; don't put a single grey slab in an otherwise black screen. Use moderate, consistent corner radii, separator lines only where useful, and strong text contrast. Keep copy and visible values faithful to the selection; never invent features just to decorate a screen.",
  "Preserve the source's user intent, content taxonomy, and brand tone while producing a genuinely improved variation rather than copying its layout mechanically. Preserve every visible meaningful datum and repeated row. Use the selected frame's actual scope and size. Keep the source untouched.",
  "For Indian BFSI designs, emphasize transparency, clear amount/date/status hierarchy, user control and accessible legibility. Never make up actual interest rates, contractual terms, or legal-compliance claims. Label illustrative financial values as sample.",
  "Keep all elements within frame bounds, use reasonable minimum touch targets for CTAs, and include the primary action and meaningful secondary paths where appropriate. Limit to 80 elements and use only supported properties.",
  "CRITICAL GEOMETRY CHECK BEFORE RETURNING: check every sibling for accidental overlap and make each text box wide/tall enough for its full copy. Never put different labels or amounts at the same coordinates. When the source uses one enclosing loan card, keep the summary and loan-wise breakdown inside the same outer card FRAME with the source's surface split; do not turn them into unrelated peer cards. Keep the status badge inside that card at its top-right edge and preserve the right-chevron/action cue. Avoid giant empty panels and never invent cards to fill scrollable whitespace.",
  "Progress indicators must preserve their meaning. Do not replace a partial progress ring (for example 60% paid) with a solid disc. Use a native ELLIPSE arcData for the progress segment (radian angles, endingAngle > startingAngle, innerRadius about 0.68–0.8), plus a muted full-circle track and centered percentage/status text. Keep the indicator layers inside a named Progress indicator FRAME. Use arcData whenever the source has a partial progress ring.",
  "Before returning the first plan, check text and numeric-value collisions, clipping, source-content omissions, card boundaries, status badge placement, progress-ring semantics and button hierarchy. UX Direct runs a bounded native read-back + rendered screenshot review after creation; choose robust Auto Layout and preserve overlays so the repair step can make surgical fixes. Do not intentionally truncate meaningful text.",
  "Return a concise user-facing summary of what you designed, not hidden reasoning. Never return null, an array at the root, a tool call, or explanatory text. Return one complete JSON object with summary, frame and elements keys; use learningCandidate:null when there is no durable reusable lesson."
].join("\n");

export async function OPTIONS(request: Request) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(request) });
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  const headers = cors(request);
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return NextResponse.json({ error: "OpenRouter is not configured on the UX Direct Worker." }, { status: 503, headers });

  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers }); }
  const requestSchema = z.object({
    prompt: z.string().trim().min(2).max(5000),
    model: z.string().trim().min(1).max(100).optional(),
    canvas: z.unknown(),
    renderedScreen: z.string().max(52000).nullable().optional(),
    visualCaptureWarning: z.string().max(400).optional(),
  }).strict();
  const parsedInput = requestSchema.safeParse(input);
  if (!parsedInput.success) return NextResponse.json({ error: "Invalid Figma agent request.", details: parsedInput.error.issues.map((issue) => (issue.path.length ? issue.path.join(".") + ": " : "request: ") + issue.message) }, { status: 400, headers });
  // Ignore a model override from older plugin UI builds. Figma generation is intentionally
  // locked to OpenRouter Auto's LOW cost tier to prevent app-level model fan-out.
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
      "Build editable semantic FRAME containers with logically nested layers. Use native Auto Layout and modern HUG/FILL/FIXED sizing on content stacks, card internals, tabs, repeated information rows and actions. A normal child in an Auto Layout parent should not rely on x/y; reserve layoutPositioning=ABSOLUTE for true overlays and intentionally layered indicators.",
      "When the local style catalogue contains a suitable style, reuse exact paintStyleId/textStyleId/effectStyleId/gridStyleId rather than recreating equivalent colors or typography. Use text styles only on TEXT nodes and reference only IDs from the supplied catalogue.",
      "When local variables/collections are supplied, use semantic names to guide consistent design. Never invent variable IDs or claim that a token was bound unless a native binding operation is verified.",
      "After native-layer creation, the plugin runs one rendered screenshot + native layer review, may perform one bounded schema-validated surgical repair, then reads and reviews the result once more. Preserve the source frame."
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
      limit: 3,
      maxChars: 2600,
      includeKnowledge: true,
    });
    brain = {
      contextText: retrieved.contextText.slice(0, 3200),
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
  // Auto routes within LOW cost tier first, then price-ordered vision-capable fallbacks.
  // The primary gets one compact retry; fallbacks get one attempt each, all sequentially.
  const models = FIGMA_AGENT_MODELS.map((entry) => entry.id);
  const errors: string[] = [];
  const recoveryContext = JSON.stringify({
    prompt: parsedInput.data.prompt,
    designScope,
    selectedNode: { name: selectedName, type: selectedType, width: selectedWidth, height: selectedHeight },
    screenshot: renderedScreen ? "Rendered screenshot attached to this request." : "No screenshot available; use native layer evidence only.",
    figmaCanvas: compactRecoveryCanvas(canvas),
  });
  const recoverySystem = [
    UX_DIRECT_DESIGN_ROLE,
    "Create an improved native Figma variation of the selected source. The user prompt is the design change, not the procedure.",
    scopeInstructions,
    "Preserve the screen/component scope, all meaningful source text and financial values, status, date, labels, rows, actions and relationships. Do not redesign it as a generic dashboard or generic stack of cards.",
    "Use the attached screenshot and source layers when available. Use semantic nested FRAMEs, Auto Layout for suitable cards and rows, clear hierarchy, strong contrast, consistent spacing and editable native shapes/text. Do not invent contractual financial details.",
    "Return one complete JSON object only with root keys summary (string), frame ({name,width,height,backgroundColor}), elements (an array of 3–6 meaningful populated FRAME section containers), and learningCandidate:null. Every element must use supported native Figma fields. This is a schema contract, not text to copy. No markdown, explanation or reasoning.",
    "OUTPUT BUDGET: use 3–6 meaningful top-level FRAME groups based on the actual screen; target 28–42 native nodes total INCLUDING nested children. Do not create a separate top-level group for a badge that belongs inside a card. Preserve every source label, amount, value, status, date and action. Keep every layer purposeful; do not add decorative placeholders to hit a count. Finish every string, array, object and the final closing brace.",
    "Every node must have type, name, x, y, width and height. Types: FRAME, RECTANGLE, ELLIPSE, TEXT, LINE, POLYGON, STAR. ELLIPSE may include arcData:{startingAngle,endingAngle,innerRadius} with radian angles and endingAngle greater than startingAngle. TEXT must have text. Only FRAME can contain children. Coordinates must be relative to the immediate parent. Use color:'#RRGGBB' and noFill:true only for transparent structural frames.",
    "Do not include a learningCandidate unless there is a durable reusable lesson. If none, set learningCandidate:null.",
  ].join("\n");
  const generationStartedAt = Date.now();
  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const attemptsForModel = modelIndex === 0 ? 2 : 1;
    for (let recoveryAttempt = 0; recoveryAttempt < attemptsForModel; recoveryAttempt += 1) {
      const isRecovery = recoveryAttempt === 1;
      const attemptTimeoutMs = isRecovery ? 16000 : (modelIndex === 0 ? 28000 : 22000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      try {
        const modelUserText = isRecovery
          ? "RECOVERY RETRY: The prior response was absent, incomplete, or invalid. Return a smaller complete JSON object following the exact compact output budget in the system message. Do not continue the old text or explain the failure.\nSOURCE CONTEXT:\n" + recoveryContext
          : (renderedScreen
            ? "Design a high-fidelity, source-faithful improvement. Combine the rendered screen image with its native layer tree. Avoid generic redesigns. Context:\n" + userContext
            : "Design a source-faithful improvement using native layer evidence only. No rendered image was available, so do not claim visual inspection. Context:\n" + userContext);
        const userContent: string | Array<Record<string, unknown>> = renderedScreen
          ? [
              { type: "text", text: modelUserText },
              { type: "image_url", image_url: { url: renderedScreen } },
            ]
          : modelUserText;
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
              { role: "system", content: isRecovery ? recoverySystem : system },
              { role: "user", content: userContent },
            ],
            ...(model.startsWith("google/gemini-") ? { temperature: isRecovery ? 0.1 : 0.15 } : {}),
            // Auto remains constrained to OpenRouter's LOW cost tier; fallbacks stay sequential.
            ...(model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}),
            ...(model === "google/gemini-3.1-flash-lite" ? { reasoning: { effort: isRecovery ? "minimal" : "low" } } : {}),
            max_tokens: isRecovery ? 6500 : 12000,
            // JSON mode is enabled for the first attempt. Compact retries use normal text mode
            // because some provider/model routes have returned successful but empty choices.
            ...(!isRecovery ? { response_format: { type: "json_object" } } : {}),
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        const responseContentType = response.headers.get("content-type") || "unknown";
        const responseText = await response.text().catch(() => "");
        let rawPayload: unknown = null;
        let responseJsonInvalid = false;
        if (responseText.trim()) {
          try {
            rawPayload = JSON.parse(responseText.replace(/^\uFEFF/, "")) as unknown;
          } catch {
            responseJsonInvalid = true;
          }
        }
        const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
          ? rawPayload as Record<string, unknown>
          : {};
        const providerError = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
          ? payload.error as Record<string, unknown>
          : {};
        if (!response.ok) {
          const detail = typeof providerError.message === "string" ? providerError.message.slice(0, 260) : "HTTP " + response.status;
          errors.push(model + (isRecovery ? " compact retry" : "") + ": " + detail);
          if (!isRecovery && [408, 429, 500, 502, 503, 504].includes(response.status)) continue;
          break;
        }
        if (!responseText.trim()) {
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider returned an empty response body (HTTP " + response.status +
            ", content-type=" + responseContentType + ").");
          if (!isRecovery) continue;
          break;
        }
        if (responseJsonInvalid) {
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider returned a non-JSON response body (HTTP " + response.status +
            ", content-type=" + responseContentType + ", chars=" + responseText.length + ").");
          if (!isRecovery) continue;
          break;
        }
        if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
          const payloadType = rawPayload === null ? "null" : Array.isArray(rawPayload) ? "array" : typeof rawPayload;
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider returned a non-object JSON envelope (type=" + payloadType + ").");
          if (!isRecovery) continue;
          break;
        }
        const nestedData = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? payload.data as Record<string, unknown> : {};
        const nestedResponse = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)
          ? payload.response as Record<string, unknown> : {};
        const nestedResult = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? payload.result as Record<string, unknown> : {};
        const responseEnvelope = Array.isArray(payload.choices) ? payload
          : Array.isArray(nestedData.choices) ? nestedData
          : Array.isArray(nestedResponse.choices) ? nestedResponse
          : Array.isArray(nestedResult.choices) ? nestedResult
          : payload;
        const choices = Array.isArray(responseEnvelope.choices) ? responseEnvelope.choices : [];
        const firstChoice = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0])
          ? choices[0] as Record<string, unknown>
          : {};
        const providerMessage = firstChoice.message && typeof firstChoice.message === "object" && !Array.isArray(firstChoice.message)
          ? firstChoice.message as Record<string, unknown>
          : {};
        const rawPlan = extractPlanJson(providerMessage.content)
          ?? extractPlanJson(providerMessage.parsed)
          ?? extractPlanJson(providerMessage.tool_calls)
          ?? extractPlanJson(providerMessage)
          ?? extractPlanJson(firstChoice)
          // Some provider adapters wrap OpenAI-compatible or native Gemini output.
          ?? extractPlanJson(payload);
        const finishReason = typeof firstChoice.finish_reason === "string" ? firstChoice.finish_reason : "unknown";
        const nativeFinishReason = typeof firstChoice.native_finish_reason === "string" ? firstChoice.native_finish_reason : "unknown";
        const wasTruncated = finishReason === "length" || nativeFinishReason === "length";
        if (wasTruncated) {
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": provider hit the output length limit (finish_reason=" + finishReason +
            ", native_finish_reason=" + nativeFinishReason + ", content=" +
            describeModelContent(providerMessage.content) + ").");
          // A valid-looking prefix can still be incomplete. Never write it; retry compactly.
          if (!isRecovery) continue;
          break;
        }
        if (rawPlan === null) {
          const messageKeys = Object.keys(providerMessage).slice(0, 10).join(",") || "none";
          const choiceKeys = Object.keys(firstChoice).slice(0, 10).join(",") || "none";
          errors.push(model + (isRecovery ? " compact retry" : "") +
            ": response contained no extractable design JSON (content=" + describeModelContent(providerMessage.content) +
            ", finish_reason=" + finishReason + ", message_keys=" + messageKeys + ", choice_keys=" + choiceKeys +
            ", tool_calls=" + (Array.isArray(providerMessage.tool_calls) ? providerMessage.tool_calls.length : 0) +
            ", payload_keys=" + (Object.keys(payload).slice(0, 12).join(",") || "none") +
            ", envelope_keys=" + (Object.keys(responseEnvelope).slice(0, 12).join(",") || "none") + ").");
          if (!isRecovery) continue;
          break;
        }
        const rawPlanRecord = rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
          ? rawPlan as Record<string, unknown> : {};
        const normalizedPlan = normalizePlan(rawPlan, canvas);
        const parsedPlan = PlanSchema.safeParse(normalizedPlan);
        if (!parsedPlan.success) {
          const issues = parsedPlan.error.issues.slice(0, 4)
            .map((issue) => issue.path.join(".") + " " + issue.message).join("; ");
          errors.push(model + (isRecovery ? " compact retry" : "") + ": invalid design plan schema (" + issues + ")");
          if (!isRecovery) continue;
          break;
        }
        const styleSets = canvas.styles && typeof canvas.styles === "object" ? canvas.styles as Record<string, unknown> : {};
        const styleReferences: Array<{ key: string; group: string; node: Record<string, unknown> }> = [];
        const collectStyleReferences = (nodes: unknown[]) => {
          for (const entry of nodes) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const node = entry as Record<string, unknown>;
            for (const [key, group] of [["paintStyleId", "paint"], ["textStyleId", "text"], ["effectStyleId", "effect"], ["gridStyleId", "grid"]] as const) {
              if (typeof node[key] === "string") styleReferences.push({ key, group, node });
            }
            if (Array.isArray(node.children)) collectStyleReferences(node.children);
          }
        };
        collectStyleReferences(parsedPlan.data.elements as unknown[]);
        const invalidStyle = styleReferences.find(({ key, group, node }) => {
          const catalogue = Array.isArray(styleSets[group]) ? styleSets[group] as Array<Record<string, unknown>> : [];
          return !catalogue.some((style) => style.id === node[key]);
        });
        if (invalidStyle) {
          errors.push(model + (isRecovery ? " compact retry" : "") + ": " + invalidStyle.key + " references an unknown local " + invalidStyle.group + " style ID.");
          if (!isRecovery) continue;
          break;
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
          generation: { recoveryAttempted: isRecovery, finishReason, modelIndex: modelIndex + 1, elapsedMs: Date.now() - generationStartedAt, totalMs: Date.now() - requestStartedAt },
        }, { headers });
      } catch (error) {
        errors.push(model + (isRecovery ? " compact retry" : "") + ": " +
          (controller.signal.aborted ? "timed out after " + attemptTimeoutMs + "ms" : error instanceof Error ? error.message.slice(0, 200) : "request failed"));
        if (!isRecovery) continue;
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return NextResponse.json({
    error: "UX Direct could not produce a valid native Figma design plan. No canvas changes were made.",
    attemptedModels: models,
    details: errors.slice(0, 6),
  }, { status: 502, headers });
}
