import { NextResponse } from "next/server";
import { z } from "zod";
import { FIGMA_AGENT_MODELS, UX_DIRECT_DESIGN_ROLE } from "@/src/providers/openrouter-models";
import { extractPlanJson } from "@/src/figma-agent/extract-plan-json";

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
  return { ...(ok ? { "Access-Control-Allow-Origin": origin! } : {}), "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept", "Cache-Control": "no-store", Vary: "Origin" };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function compactNode(value: unknown, state: { count: number }, depth = 0): Record<string, unknown> | null {
  if (!isRecord(value) || state.count >= 100) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.type !== "string") return null;
  state.count += 1;
  const output: Record<string, unknown> = { id: value.id.slice(0, 100), name: value.name.slice(0, 100), type: value.type.slice(0, 40) };
  for (const key of ["text", "layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "textAutoResize",
    "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems"] as const) {
    if (typeof value[key] === "string") output[key] = (value[key] as string).slice(0, 100);
  }
  for (const key of ["x", "y", "width", "height", "fontSize", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) output[key] = value[key];
  }
  if (Array.isArray(value.fillColors)) output.fillColors = value.fillColors.filter((v): v is string => typeof v === "string").slice(0, 4);
  if (Array.isArray(value.children) && depth < 5) {
    output.children = [];
    for (const child of value.children.slice(0, 60)) {
      const nested = compactNode(child, state, depth + 1);
      if (nested) (output.children as Record<string, unknown>[]).push(nested);
      if (state.count >= 100) break;
    }
  }
  return output;
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  visible: z.boolean().optional(),
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
  width: z.number().finite().min(1).max(4096).optional(),
  height: z.number().finite().min(1).max(4096).optional(),
  fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(100).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
  clipsContent: z.boolean().optional(),
  text: z.string().max(5000).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  fontSize: z.number().finite().min(8).max(144).optional(),
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
  primaryAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
  counterAxisSizingMode: z.enum(["AUTO", "FIXED"]).optional(),
  horizontalConstraint: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  verticalConstraint: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  shadowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  shadowBlur: z.number().finite().min(0).max(200).optional(),
  shadowX: z.number().finite().min(-200).max(200).optional(),
  shadowY: z.number().finite().min(-200).max(200).optional(),
  shadowSpread: z.number().finite().min(-200).max(200).optional(),
}).strict().refine(v => Object.values(v).some(x => x !== undefined), { message: "Patch must contain an editable property." });

const elementSchema: z.ZodTypeAny = z.lazy(() => z.object({
  type: z.enum(["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "VECTOR"]),
  name: z.string().trim().min(1).max(80),
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
  width: z.number().finite().min(1).max(4096).optional(),
  height: z.number().finite().min(1).max(4096).optional(),
  text: z.string().max(5000).optional(),
  fontSize: z.number().finite().min(8).max(144).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  paintStyleId: z.string().trim().min(1).max(300).optional(),
  textStyleId: z.string().trim().min(1).max(300).optional(),
  effectStyleId: z.string().trim().min(1).max(300).optional(),
  gridStyleId: z.string().trim().min(1).max(300).optional(),
  noFill: z.boolean().optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(100).optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
  clipsContent: z.boolean().optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional(),
  layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
  itemSpacing: z.number().finite().min(-100).max(1000).optional(),
  paddingLeft: z.number().finite().min(0).max(1000).optional(),
  paddingRight: z.number().finite().min(0).max(1000).optional(),
  paddingTop: z.number().finite().min(0).max(1000).optional(),
  paddingBottom: z.number().finite().min(0).max(1000).optional(),
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
  shadowBlur: z.number().finite().min(0).max(200).optional(),
  shadowX: z.number().finite().min(-200).max(200).optional(),
  shadowY: z.number().finite().min(-200).max(200).optional(),
  shadowSpread: z.number().finite().min(-200).max(200).optional(),
  children: z.array(elementSchema).max(80).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.type === "TEXT" && typeof v.text !== "string") ctx.addIssue({ code: "custom", path: ["text"], message: "TEXT elements need text." });
  if (v.type !== "FRAME" && Array.isArray(v.children) && v.children.length) ctx.addIssue({ code: "custom", path: ["children"], message: "Only FRAME can contain children." });
  if (v.type !== "FRAME" && v.layoutMode !== undefined) ctx.addIssue({ code: "custom", path: ["layoutMode"], message: "Auto Layout requires a FRAME." });
}));

const actionSchema = z.object({
  operation: z.enum(["update-node", "create-elements", "insert-image", "delete-node", "clone-node", "reorder-node", "reparent-node",
    "group-nodes", "ungroup-node", "create-component", "create-component-set", "create-instance", "swap-component",
    "detach-instance", "set-text-range", "apply-style", "create-variables", "bind-variable", "set-selection", "zoom-to-nodes"]),
  nodeId: z.string().trim().min(1).max(100).optional(),
  parentNodeId: z.string().trim().min(1).max(100).optional(),
  nodeIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  index: z.number().int().min(0).max(10000).optional(),
  componentId: z.string().trim().min(1).max(100).optional(),
  styleKind: z.enum(["paint", "text", "effect", "grid"]).optional(),
  styleId: z.string().trim().min(1).max(300).optional(),
  styleName: z.string().trim().min(1).max(240).optional(),
  patch: patchSchema.optional(),
  elements: z.array(elementSchema).min(1).max(20).optional(),
  range: z.object({
    start: z.number().int().min(0).max(5000), end: z.number().int().min(1).max(5000),
    fontSize: z.number().finite().min(8).max(144).optional(),
    lineHeight: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(1).max(500) }).strict().optional(),
    letterSpacing: z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(-100).max(500) }).strict().optional(),
    fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).strict().optional(),
  target: z.enum(["current-page", "node", "selection"]).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
  width: z.number().finite().min(1).max(4096).optional(),
  height: z.number().finite().min(1).max(4096).optional(),
  scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
  useAttachedImage: z.boolean().optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
  layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
  layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  collectionName: z.string().trim().min(1).max(100).optional(),
  modeName: z.string().trim().min(1).max(100).optional(),
  variables: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
    value: z.union([z.string().max(300), z.number().finite(), z.boolean()]),
  }).strict()).max(80).optional(),
  variableName: z.string().trim().min(1).max(100).optional(),
  property: z.enum(["fill", "stroke", "opacity", "cornerRadius", "width", "height", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"]).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.operation === "update-node" && (!v.nodeId || !v.patch)) ctx.addIssue({ code: "custom", path: [], message: "update-node requires nodeId and patch." });
  if (v.operation === "create-elements" && (!v.target || (v.target === "node" && !v.parentNodeId) || !v.elements)) ctx.addIssue({ code: "custom", path: [], message: "create-elements requires target, an optional target parent, and elements." });
  if (v.operation === "insert-image" && (!v.useAttachedImage || !v.target || (v.target === "node" && !v.parentNodeId))) ctx.addIssue({ code: "custom", path: [], message: "insert-image requires an attached image and a target." });
  if (["delete-node", "clone-node", "reorder-node", "create-component", "create-instance", "detach-instance", "set-text-range", "apply-style", "bind-variable", "reparent-node"].includes(v.operation) && !v.nodeId) ctx.addIssue({ code: "custom", path: ["nodeId"], message: "This operation requires nodeId." });
  if (v.operation === "reparent-node" && (!v.parentNodeId || v.parentNodeId === v.nodeId)) ctx.addIssue({ code: "custom", path: ["parentNodeId"], message: "reparent-node requires a different parentNodeId." });
  if (v.operation === "reorder-node" && v.index === undefined) ctx.addIssue({ code: "custom", path: ["index"], message: "reorder-node requires index." });
  if (["group-nodes", "create-component-set"].includes(v.operation) && (!v.nodeIds || v.nodeIds.length < 2)) ctx.addIssue({ code: "custom", path: ["nodeIds"], message: v.operation + " requires at least two node IDs." });
  if (["create-component-set", "group-nodes", "set-selection", "zoom-to-nodes"].includes(v.operation) && !v.nodeIds) ctx.addIssue({ code: "custom", path: ["nodeIds"], message: "This operation requires nodeIds." });
  if (v.operation === "swap-component" && (!v.nodeId || !v.componentId)) ctx.addIssue({ code: "custom", path: [], message: "swap-component requires nodeId and componentId." });
  if (v.operation === "create-variables" && (!v.collectionName || !v.variables?.length)) ctx.addIssue({ code: "custom", path: [], message: "create-variables requires collectionName and variables." });
  if (v.operation === "bind-variable" && (!v.nodeId || !v.variableName || !v.property)) ctx.addIssue({ code: "custom", path: [], message: "bind-variable requires nodeId, variableName and property." });
  if (v.operation === "apply-style" && (!v.nodeId || !v.styleKind || (!v.styleId && !v.styleName))) ctx.addIssue({ code: "custom", path: [], message: "apply-style requires a target and local style identifier/name." });
});

function flattenNodes(nodes: unknown[], ids = new Set<string>()) {
  for (const value of nodes) {
    if (!isRecord(value)) continue;
    if (typeof value.id === "string") ids.add(value.id);
    if (Array.isArray(value.children)) flattenNodes(value.children, ids);
  }
  return ids;
}
function idsUsedByAction(action: z.infer<typeof actionSchema>): string[] {
  return [action.nodeId, action.parentNodeId, action.componentId, ...(action.nodeIds || [])].filter((id): id is string => typeof id === "string");
}

export async function OPTIONS(request: Request) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors(request) });
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  const headers = cors(request);
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: "OpenRouter is not configured." }, { status: 503, headers });
  const raw = await request.json().catch(() => null);
  const requestSchema = z.object({
    prompt: z.string().trim().min(2).max(5000),
    canvas: z.unknown(),
    referenceImage: z.string().max(250000).nullable().optional(),
    renderedScreen: z.string().max(52000).nullable().optional(),
  }).strict();
  const input = requestSchema.safeParse(raw);
  if (!input.success) return NextResponse.json({ error: "Invalid native Figma action request.", details: input.error.issues }, { status: 400, headers });
  const canvasRaw = isRecord(input.data.canvas) ? input.data.canvas : {};
  const state = { count: 0 };
  const roots = Array.isArray(canvasRaw.nodes) ? canvasRaw.nodes : [];
  const canvasNodes = roots.slice(0, 8).map(v => compactNode(v, state)).filter((v): v is Record<string, unknown> => !!v);
  const compactResourceList = (value: unknown, limit = 50) => Array.isArray(value) ? value.slice(0, limit).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    return [{ id: entry.id.slice(0, 300), name: entry.name.slice(0, 120),
      ...(typeof entry.type === "string" ? { type: entry.type.slice(0, 40) } : {}),
      ...(typeof entry.collectionName === "string" ? { collectionName: entry.collectionName.slice(0, 100) } : {}),
      ...(typeof entry.collectionId === "string" ? { collectionId: entry.collectionId.slice(0, 300) } : {}) }];
  }) : [];
  const rawStyles = isRecord(canvasRaw.styles) ? canvasRaw.styles : {};
  const styles = { paint: compactResourceList(rawStyles.paint), text: compactResourceList(rawStyles.text),
    effect: compactResourceList(rawStyles.effect), grid: compactResourceList(rawStyles.grid) };
  const variables = compactResourceList(canvasRaw.variables, 120);
  const variableCollections = Array.isArray(canvasRaw.variableCollections) ? canvasRaw.variableCollections.slice(0, 30).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    return [{ id: entry.id.slice(0, 300), name: entry.name.slice(0, 100),
      modes: Array.isArray(entry.modes) ? entry.modes.slice(0, 8).flatMap((mode) =>
        isRecord(mode) && typeof mode.modeId === "string" && typeof mode.name === "string"
          ? [{ modeId: mode.modeId.slice(0, 100), name: mode.name.slice(0, 100) }] : []) : [] }];
  }) : [];
  const canvas = { pageName: typeof canvasRaw.pageName === "string" ? canvasRaw.pageName.slice(0, 100) : "",
    nodes: canvasNodes, nodeCount: state.count, styles, variables, variableCollections };
  const allowedIds = flattenNodes(canvasNodes);
  if (allowedIds.size === 0) return NextResponse.json({ error: "Select a layer/container first so the action planner can target real Figma node IDs." }, { status: 400, headers });
  const referenceImage = typeof input.data.referenceImage === "string" &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.data.referenceImage) ? input.data.referenceImage : null;
  const renderedScreen = typeof input.data.renderedScreen === "string" &&
    input.data.renderedScreen.length <= 52000 &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.data.renderedScreen) ? input.data.renderedScreen : null;
  const system = [
    UX_DIRECT_DESIGN_ROLE + " You are the native-canvas action planner for UX Direct. Work on actual selected/inspected Figma nodes; do not create a new screen unless explicitly requested.",
    "Translate the user's request into the smallest valid ordered set of native Figma operations. Return JSON only: {summary:string, actions:[...]}. Each action maps directly to a Figma native command; the plugin executes them sequentially and verifies read-back.",
    "Allowed operations: update-node, create-elements, insert-image, delete-node, clone-node, reorder-node, reparent-node, group-nodes, ungroup-node, create-component, create-component-set, create-instance, swap-component, detach-instance, set-text-range, apply-style, create-variables, bind-variable, set-selection, zoom-to-nodes.",
    "For color or text fill changes use update-node.patch.fillColor; for text content edits use update-node.patch.text. For typography set fontFamily, fontStyle, fontSize, textAutoResize and textAlignHorizontal only on TEXT nodes. For responsive UI use layoutMode, itemSpacing, padding, alignment, sizing and constraints through update-node; prefer modern HUG/FILL sizing with an Auto Layout parent.",
    "Use only node IDs that appear in canvas. Do not guess or fabricate IDs. If the target is ambiguous, choose the smallest reasonable set in the current selection and name it in the summary. Never delete nodes unless deletion was explicitly asked. Preserve unrelated content and the original visual intent.",
    "Use create-elements to add native layers into the current selected container (target:'node', parentNodeId:'...'). Children are nested under FRAME elements only. Use insert-image only when an actual user-attached image is available in this request; set useAttachedImage:true and don't invent an image URL. A rendered screenshot is visual evidence only, not an insertable asset. Never place base64 data in model output.",
    "When a rendered screenshot is available, inspect hierarchy, text density, collisions, clipped content, component boundaries and spacing. Prefer minimal direct edits for narrow requests; use coherent native action batches for broader requests.",
    "Use apply-style only with a local style in canvas.styles (exact style ID preferred; exact name allowed only when unique). If absent or ambiguous, use a supported literal property instead of guessing. Use create-variables only for explicit design-token requests; bind-variable only to a variable listed in canvas.variables and pass its exact collectionName when duplicate names exist. For variants, create components first, then combine only actual sibling components.",
    "Operation count 1–12. Use the least number of actions, prefer one update patch per node, and never return explanatory prose, markdown, unsupported fields, or tool calls.",
    "Native execution is irreversible for some operations. Ask for no confirmation in JSON; the host requires explicit user prompt to execute, and delete-node is allowed only when the request clearly asks to delete/remove.",
  ].join("\n");
  const userText = JSON.stringify({
    prompt: input.data.prompt, canvas,
    userAttachedImageAvailable: !!referenceImage,
    renderedScreenshotAvailable: !!renderedScreen,
    safety: "The rendered screenshot is visual evidence only. Only referenceImage is a user-attached asset eligible for insert-image."
  });
  const images: Array<Record<string, unknown>> = [];
  if (renderedScreen) images.push({ type: "image_url", image_url: { url: renderedScreen } });
  if (referenceImage) images.push({ type: "image_url", image_url: { url: referenceImage } });
  const content: string | Array<Record<string, unknown>> = images.length
    ? [{ type: "text", text: userText }, ...images]
    : userText;
  const models = FIGMA_AGENT_MODELS.map(m => m.id);
  const errors: string[] = [];
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), modelIndex === 0 ? 25000 : 18000);
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", Accept: "application/json",
          "HTTP-Referer": new URL(request.url).origin, "X-OpenRouter-Title": "UX Direct Native Figma Actions" },
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content }],
          ...(model === "openrouter/auto" ? { plugins: [{ id: "auto-router", cost_tier: "low" }] } : {}),
          ...(model.startsWith("google/gemini-") ? { temperature: 0.1 } : {}),
          max_tokens: 3500, response_format: { type: "json_object" } }),
        cache: "no-store", signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      const envelope = isRecord(payload) ? payload : {};
      if (!response.ok) {
        const err = isRecord(envelope.error) ? envelope.error : {};
        errors.push(model + ": " + String(err.message || "HTTP " + response.status).slice(0, 140));
        continue;
      }
      const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const message = isRecord(choice.message) ? choice.message : {};
      const decoded = extractPlanJson(message.content) ?? extractPlanJson(message.parsed) ?? extractPlanJson(message);
      if (!isRecord(decoded) || !Array.isArray(decoded.actions)) { errors.push(model + ": response has no actions array"); continue; }
      const parsedActions = z.object({ summary: z.string().trim().min(4).max(500), actions: z.array(actionSchema).min(1).max(12) }).strict().safeParse(decoded);
      if (!parsedActions.success) { errors.push(model + ": invalid actions schema: " + parsedActions.error.issues.slice(0, 3).map(i => i.path.join(".") + " " + i.message).join("; ")); continue; }
      const actions = parsedActions.data.actions;
      const badId = actions.flatMap(idsUsedByAction).find(id => !allowedIds.has(id));
      if (badId) { errors.push(model + ": action used a node ID not present in the inspected selection"); continue; }
      const styles: Record<string, unknown> = isRecord(canvas.styles) ? canvas.styles : {};
      const invalidStyleAction = actions.find((action) => {
        if (action.operation !== "apply-style" || !action.styleKind) return false;
        const catalogue = Array.isArray(styles[action.styleKind]) ? styles[action.styleKind] as Array<Record<string, unknown>> : [];
        if (action.styleId) return !catalogue.some((style) => style.id === action.styleId);
        return catalogue.filter((style) => style.name === action.styleName).length !== 1;
      });
      if (invalidStyleAction) { errors.push(model + ": apply-style references a missing or ambiguous local style; use an exact supplied style ID or literal property edit"); continue; }
      const variables = Array.isArray(canvas.variables) ? canvas.variables as Array<Record<string, unknown>> : [];
      const invalidVariableAction = actions.find((action) => {
        if (action.operation !== "bind-variable") return false;
        const matches = variables.filter((variable) => variable.name === action.variableName &&
          (!action.collectionName || variable.collectionName === action.collectionName));
        return matches.length !== 1;
      });
      if (invalidVariableAction) { errors.push(model + ": bind-variable references a missing or ambiguous local variable; specify its exact collectionName"); continue; }
      if (actions.some(a => a.operation === "delete-node") && !/\b(delete|remove|discard)\b/i.test(input.data.prompt)) {
        errors.push(model + ": deletion rejected because the prompt does not explicitly request removal"); continue;
      }
      if (actions.some(a => a.operation === "insert-image") && !referenceImage) {
        errors.push(model + ": image insertion rejected because no image was attached"); continue;
      }
      return NextResponse.json({ ok: true, summary: parsedActions.data.summary, actions, model: typeof envelope.model === "string" ? envelope.model : model,
        inspectedNodes: allowedIds.size, referenceImageAttached: !!referenceImage }, { headers });
    } catch (error) {
      errors.push(model + ": " + (controller.signal.aborted ? "timed out" : error instanceof Error ? error.message.slice(0, 140) : "request failed"));
    } finally { clearTimeout(timeout); }
  }
  return NextResponse.json({ error: "UX Direct could not create a valid native Figma action plan. No canvas changes were made.", details: errors.slice(0, 4) }, { status: 502, headers });
}
