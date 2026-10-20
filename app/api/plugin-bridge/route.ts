import { listR2Keys, readR2Json, writeR2Json } from "@/src/storage/r2-json-store";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordOperationalEvent } from "@/src/observability/event-log";
import { ALLOWED_FIGMA_FILE_KEY, isAllowedFigmaFileKey } from "@/src/security/figma-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREFIX = "ux-direct-bridge";
const PLUGIN_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
const ID = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const CHECK = z.object({
  category: z.string().max(80),
  name: z.string().max(120),
  level: z.enum(["availability", "functional", "not-tested"]),
  status: z.enum(["success", "error", "not-tested"]),
  reason: z.string().max(400),
});
const REPORT = z.object({
  passed: z.number().int().nonnegative(),
  available: z.number().int().nonnegative().optional().default(0),
  failed: z.number().int().nonnegative(),
  notTested: z.number().int().nonnegative(),
  checkedAt: z.string().max(50),
  checks: z.array(CHECK).max(300),
});

const CANVAS_ELEMENT = z.object({
  type: z.enum(["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "SLICE", "VECTOR"]),
  name: z.string().trim().min(1).max(80),
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
  width: z.number().finite().min(1).max(4096).optional(),
  height: z.number().finite().min(1).max(4096).optional(),
  rotation: z.number().finite().min(-360).max(360).optional(),
  text: z.string().max(5000).optional(),
  fontSize: z.number().finite().min(8).max(144).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(100).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
  clipsContent: z.boolean().optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
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
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  pointCount: z.number().int().min(3).max(100).optional(),
  innerRadius: z.number().finite().min(0.01).max(1).optional(),
  vectorPaths: z.array(z.object({ windingRule: z.enum(["EVENODD", "NONZERO"]), data: z.string().trim().min(1).max(5000) }).strict()).min(1).max(5).optional(),
  shadowColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  shadowBlur: z.number().finite().min(0).max(200).optional(),
  shadowX: z.number().finite().min(-200).max(200).optional(),
  shadowY: z.number().finite().min(-200).max(200).optional(),
  shadowSpread: z.number().finite().min(-200).max(200).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === "TEXT" && typeof value.text !== "string") {
    ctx.addIssue({ code: "custom", path: ["text"], message: "TEXT elements require text content." });
  }
  if (value.type === "VECTOR" && (!value.vectorPaths || value.vectorPaths.length < 1)) {
    ctx.addIssue({ code: "custom", path: ["vectorPaths"], message: "VECTOR elements require vectorPaths." });
  }
  if (value.pointCount !== undefined && !["POLYGON", "STAR"].includes(value.type)) {
    ctx.addIssue({ code: "custom", path: ["pointCount"], message: "pointCount is supported only on POLYGON and STAR nodes." });
  }
});
const CANVAS_READ_PAYLOAD = z.object({
  scope: z.enum(["selection", "current-page"]).default("selection"),
  maxDepth: z.number().int().min(0).max(4).default(2),
  maxNodes: z.number().int().min(1).max(100).default(60),
  queryName: z.string().trim().min(1).max(120).optional(),
  queryType: z.string().trim().min(1).max(80).optional(),
  includePages: z.boolean().optional(),
  includeStyles: z.boolean().optional(),
}).strict();
const CANVAS_PATCH = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  visible: z.boolean().optional(),
  x: z.number().finite().min(-10000).max(10000).optional(),
  y: z.number().finite().min(-10000).max(10000).optional(),
  width: z.number().finite().min(1).max(4096).optional(),
  height: z.number().finite().min(1).max(4096).optional(),
  rotation: z.number().finite().min(-360).max(360).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWeight: z.number().finite().min(0).max(100).optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
  clipsContent: z.boolean().optional(),
  text: z.string().max(5000).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  fontSize: z.number().finite().min(8).max(144).optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
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
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "Provide at least one supported property to update.",
});
const CANVAS_TEXT_RANGE = z.object({
  start: z.number().int().min(0).max(5000),
  end: z.number().int().min(1).max(5000),
  fontSize: z.number().finite().min(8).max(144).optional(),
  lineHeight: z.object({
    unit: z.enum(["PIXELS", "PERCENT"]),
    value: z.number().finite().min(1).max(500),
  }).strict().optional(),
  letterSpacing: z.object({
    unit: z.enum(["PIXELS", "PERCENT"]),
    value: z.number().finite().min(-100).max(500),
  }).strict().optional(),
  fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.end <= value.start) {
    ctx.addIssue({ code: "custom", path: ["end"], message: "Text range end must be greater than start." });
  }
  if (value.fontSize === undefined && value.lineHeight === undefined &&
      value.letterSpacing === undefined && value.fillColor === undefined) {
    ctx.addIssue({ code: "custom", path: [], message: "Provide at least one text-range property to set." });
  }
});
const CANVAS_WRITE_STEP = z.object({
  operation: z.enum([
    "create-elements", "update-node", "clone-node", "delete-node", "reorder-node", "reparent-node",
    "group-nodes", "flatten-nodes", "boolean-operation", "ungroup-node", "create-component", "create-component-set", "create-instance", "swap-component",
    "detach-instance", "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill",
  ]),
  target: z.enum(["current-page", "selection", "test-lab"]).optional(),
  elements: z.array(CANVAS_ELEMENT).min(1).max(20).optional(),
  nodeId: z.string().trim().min(1).max(100).optional(),
  parentNodeId: z.string().trim().min(1).max(100).optional(),
  pageId: z.string().trim().min(1).max(100).optional(),
  nodeIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  index: z.number().int().min(0).max(10000).optional(),
  pageName: z.string().trim().min(1).max(120).optional(),
  styleKind: z.enum(["paint", "text", "effect", "grid"]).optional(),
  styleId: z.string().trim().min(1).max(300).optional(),
  styleName: z.string().trim().min(1).max(240).optional(),
  booleanOperation: z.enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]).optional(),
  componentId: z.string().trim().min(1).max(100).optional(),
  format: z.enum(["PNG", "PDF", "SVG_STRING"]).optional(),
  scale: z.number().finite().min(0.2).max(1).optional(),
  range: CANVAS_TEXT_RANGE.optional(),
  imageBase64: z.string().max(250000).optional(),
  scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
  patch: CANVAS_PATCH.optional(),
}).strict();
const CANVAS_WRITE_PAYLOAD = z.object({
  operation: z.enum([
    "batch", "create-elements", "update-node", "clone-node", "delete-node", "reorder-node", "reparent-node",
    "group-nodes", "flatten-nodes", "boolean-operation", "ungroup-node", "create-component", "create-component-set", "create-instance", "swap-component",
    "detach-instance", "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill",
  ]),
  confirm: z.literal(true),
  target: z.enum(["current-page", "selection", "test-lab"]).optional(),
  elements: z.array(CANVAS_ELEMENT).min(1).max(20).optional(),
  nodeId: z.string().trim().min(1).max(100).optional(),
  parentNodeId: z.string().trim().min(1).max(100).optional(),
  pageId: z.string().trim().min(1).max(100).optional(),
  nodeIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  index: z.number().int().min(0).max(10000).optional(),
  pageName: z.string().trim().min(1).max(120).optional(),
  styleKind: z.enum(["paint", "text", "effect", "grid"]).optional(),
  styleId: z.string().trim().min(1).max(300).optional(),
  styleName: z.string().trim().min(1).max(240).optional(),
  booleanOperation: z.enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]).optional(),
  componentId: z.string().trim().min(1).max(100).optional(),
  format: z.enum(["PNG", "PDF", "SVG_STRING"]).optional(),
  range: CANVAS_TEXT_RANGE.optional(),
  imageBase64: z.string().max(250000).optional(),
  scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
  patch: CANVAS_PATCH.optional(),
  actions: z.array(CANVAS_WRITE_STEP).min(1).max(40).optional(),
}).strict().superRefine((value, ctx) => {
  const requiresNode = ["update-node", "clone-node", "delete-node", "reorder-node", "ungroup-node",
    "create-component", "create-instance", "swap-component", "detach-instance", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill", "reparent-node"].includes(value.operation);
  if (requiresNode && !value.nodeId) {
    ctx.addIssue({ code: "custom", path: ["nodeId"], message: value.operation + " requires nodeId." });
  }
  if (value.operation === "create-elements" && !value.elements) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "create-elements requires 1–20 elements." });
  }
  if (value.operation === "update-node" && (!value.nodeId || !value.patch)) {
    ctx.addIssue({ code: "custom", path: ["patch"], message: "update-node requires nodeId and a supported patch." });
  }
  if (value.operation === "reorder-node" && value.index === undefined) {
    ctx.addIssue({ code: "custom", path: ["index"], message: "reorder-node requires index." });
  }
  if (value.operation === "group-nodes" && (!value.nodeIds || value.nodeIds.length < 2 || new Set(value.nodeIds).size !== value.nodeIds.length)) {
    ctx.addIssue({ code: "custom", path: ["nodeIds"], message: "group-nodes requires at least two unique node IDs." });
  }
  if ((value.operation === "flatten-nodes" || value.operation === "boolean-operation") && (!value.nodeIds || value.nodeIds.length < (value.operation === "flatten-nodes" ? 1 : 2))) {
    ctx.addIssue({ code: "custom", path: ["nodeIds"], message: value.operation + " requires nodeIds." });
  }
  if (value.operation === "boolean-operation" && !value.booleanOperation) {
    ctx.addIssue({ code: "custom", path: ["booleanOperation"], message: "boolean-operation requires UNION, SUBTRACT, INTERSECT, or EXCLUDE." });
  }
  if (value.operation === "create-component-set" && (!value.nodeIds || value.nodeIds.length < 2)) {
    ctx.addIssue({ code: "custom", path: ["nodeIds"], message: "create-component-set requires at least two component IDs." });
  }
  if (value.operation === "swap-component" && !value.componentId) {
    ctx.addIssue({ code: "custom", path: ["componentId"], message: "swap-component requires componentId." });
  }
  if (value.operation === "set-text-range" && !value.range) {
    ctx.addIssue({ code: "custom", path: ["range"], message: "set-text-range requires a range object." });
  }
  if (value.operation === "export-node" && !value.format) {
    ctx.addIssue({ code: "custom", path: ["format"], message: "export-node requires PNG, PDF, or SVG_STRING." });
  }
  if (value.operation === "create-image-fill" && (!value.imageBase64 || !value.nodeId)) {
    ctx.addIssue({ code: "custom", path: ["imageBase64"], message: "create-image-fill requires nodeId and imageBase64." });
  }
  if (value.operation === "set-selection" && !value.nodeIds) {
    ctx.addIssue({ code: "custom", path: ["nodeIds"], message: "set-selection requires nodeIds (use an empty array to clear selection)." });
  }
  if (value.operation === "zoom-to-nodes" && (!value.nodeIds || value.nodeIds.length < 1)) {
    ctx.addIssue({ code: "custom", path: ["nodeIds"], message: "zoom-to-nodes requires at least one node ID." });
  }
  if (value.operation === "apply-style" && (!value.styleKind || (!value.styleId && !value.styleName))) {
    ctx.addIssue({ code: "custom", path: ["styleKind"], message: "apply-style requires styleKind and either styleId or styleName." });
  }
  if (value.operation === "set-current-page" && !value.pageId) {
    ctx.addIssue({ code: "custom", path: ["pageId"], message: "set-current-page requires pageId." });
  }
  if (value.operation === "reparent-node" && (!value.parentNodeId || value.parentNodeId === value.nodeId)) {
    ctx.addIssue({ code: "custom", path: ["parentNodeId"], message: "reparent-node requires a different parentNodeId." });
  }
  if (value.operation === "create-page" && !value.pageName) {
    ctx.addIssue({ code: "custom", path: ["pageName"], message: "create-page requires pageName." });
  }
  if (value.operation === "rename-page" && !value.pageName) {
    ctx.addIssue({ code: "custom", path: ["pageName"], message: "rename-page requires pageName." });
  }
  if (value.operation === "batch" && !value.actions) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "batch requires 1–40 actions." });
  }
  if (value.operation !== "batch" && value.actions) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "actions is supported only for batch." });
  }
  if (value.operation === "batch" && value.actions && value.actions.some((step) => ["export-svg", "export-node", "create-image-fill"].includes(step.operation)) && value.actions.length > 1) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "Exports and image fills with inline image data must be standalone commands to preserve bridge size limits." });
  }
  if (value.operation === "batch" && value.actions) {
    const totalCreated = value.actions.reduce((sum, step) => sum + (step.operation === "create-elements" && step.elements ? step.elements.length : 0), 0);
    if (totalCreated > 100) {
      ctx.addIssue({ code: "custom", path: ["actions"], message: "A batch can create at most 100 canvas nodes in total." });
    }
  }
  if (value.operation === "update-node" && value.elements) {
    ctx.addIssue({ code: "custom", path: ["elements"], message: "update-node cannot include elements." });
  }
});
type HealthReport = z.infer<typeof REPORT>;
type BridgeCommand = {
  commandId: string; action: "native-api-health-check" | "read-canvas" | "write-canvas";
  status: "pending" | "claimed" | "completed" | "failed";
  issuedAt: string; expiresAt: string; claimedAt?: string; completedAt?: string; failure?: string;
  payload?: Record<string, unknown>; result?: unknown;
};
type Session = {
  clientId: string; sessionToken: string; fileKey: string; status: "online" | "offline";
  connectedAt: string; lastHeartbeatAt: string; disconnectedAt?: string; lastTestAt?: string;
  latestCommand?: BridgeCommand; healthReport?: HealthReport;
};
const sessionPath = (id: string) => `${PREFIX}/sessions/${id}/session.json`;
const commandPath = (id: string) => `${PREFIX}/sessions/${id}/command.json`;
const latestReportPath = `${PREFIX}/reports/latest.json`;
type PersistedHealthReport = { clientId: string; commandId?: string; savedAt: string; healthReport: HealthReport };

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const selfOrigin = new URL(request.url).origin;
  const allowedOrigin = origin && (origin === selfOrigin || PLUGIN_ORIGINS.has(origin)) ? origin : selfOrigin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}
function isDashboardRequest(request: Request, requireExplicitOrigin = false): boolean {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin || (!requireExplicitOrigin && !origin);
}
function isPluginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && PLUGIN_ORIGINS.has(origin);
}
async function readJson<T>(pathname: string): Promise<T | null> {
  return readR2Json<T>(pathname);
}
async function writeJson(pathname: string, value: unknown): Promise<void> {
  return writeR2Json(pathname, value);
}
function publicSession(session: Session) {
  const { sessionToken: _neverExpose, ...safe } = session;
  return safe;
}
async function listSessions() {
  const sessionKeys = (await listR2Keys(`${PREFIX}/sessions/`, 1000))
    .filter((key) => key.endsWith("/session.json"));
  const sessions = await Promise.all(sessionKeys.map(async (key) => {
    try { return await readJson<Session>(key); } catch { return null; }
  }));
  const now = Date.now();
  return sessions.filter((session): session is Session => !!session && isAllowedFigmaFileKey(session.fileKey)).map((session) => ({
    ...publicSession(session),
    isOnline: session.status === "online" && now - Date.parse(session.lastHeartbeatAt) < 75000,
  })).sort((a, b) => Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt)).slice(0, 20);
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  if (!isDashboardRequest(request)) {
    return NextResponse.json({ error: "Dashboard origin required for bridge inspection." }, { status: 403, headers });
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  try {
    if (mode === "sessions") {
      const [sessions, latestReport] = await Promise.all([
        listSessions(), readJson<PersistedHealthReport>(latestReportPath),
      ]);
      return NextResponse.json({ sessions, latestReport }, { headers });
    }
    if (mode === "state") {
      const parsedId = ID.safeParse(url.searchParams.get("clientId"));
      if (!parsedId.success) return NextResponse.json({ error: "A valid clientId is required." }, { status: 400, headers });
      const session = await readJson<Session>(sessionPath(parsedId.data));
      if (!session || !isAllowedFigmaFileKey(session.fileKey)) return NextResponse.json({ error: "Allowlisted plugin session not found." }, { status: 404, headers });
      const now = Date.now();
      const latestReport = await readJson<PersistedHealthReport>(latestReportPath);
      return NextResponse.json({
        session: { ...publicSession(session), isOnline: session.status === "online" && now - Date.parse(session.lastHeartbeatAt) < 75000 },
        latestReport,
      }, { headers });
    }
    return NextResponse.json({ error: "Unsupported bridge mode." }, { status: 400, headers });
  } catch (error) {
    console.error("[ux-direct-bridge] Cloudflare R2 read failed", error);
    return NextResponse.json({ error: "Could not read bridge state from Cloudflare R2 storage." }, { status: 500, headers });
  }
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers }); }

  const mode = body.mode;
  const isDashboardCommand = mode === "command";
  if (isDashboardCommand ? !isDashboardRequest(request, true) : !isPluginRequest(request)) {
    return NextResponse.json({ error: isDashboardCommand ? "Dashboard origin required to issue a command." : "Figma plugin origin required." }, { status: 403, headers });
  }
  if (isDashboardCommand) {
    const internalSecret = process.env.UX_DIRECT_MCP_OAUTH_SECRET;
    if (!internalSecret || request.headers.get("x-ux-direct-internal") !== internalSecret) {
      return NextResponse.json({ error: "Internal command authentication failed." }, { status: 403, headers });
    }
  }
  if (!isDashboardCommand && !isAllowedFigmaFileKey(body.fileKey)) {
    return NextResponse.json({ error: "Figma plugin request blocked: file key is not allowlisted." }, { status: 403, headers });
  }

  const idResult = ID.safeParse(body.clientId);
  if (!idResult.success) return NextResponse.json({ error: "A valid clientId is required." }, { status: 400, headers });
  const clientId = idResult.data;
  const path = sessionPath(clientId);

  try {
    if (mode === "plugin-command") {
      const token = z.string().min(20).max(200).safeParse(body.sessionToken);
      const action = z.enum(["read-canvas", "write-canvas"]).safeParse(body.action);
      if (!token.success || !action.success) {
        return NextResponse.json({ error: "A valid session token and canvas action are required." }, { status: 400, headers });
      }
      let commandPayload: Record<string, unknown> | undefined;
      if (action.data === "read-canvas") {
        const parsed = CANVAS_READ_PAYLOAD.safeParse(body.payload ?? {});
        if (!parsed.success) return NextResponse.json({ error: "Canvas read options are invalid.", issues: parsed.error.issues }, { status: 400, headers });
        commandPayload = parsed.data as unknown as Record<string, unknown>;
      } else {
        const parsed = CANVAS_WRITE_PAYLOAD.safeParse(body.payload);
        if (!parsed.success) return NextResponse.json({ error: "Canvas write payload is invalid.", issues: parsed.error.issues }, { status: 400, headers });
        commandPayload = parsed.data as unknown as Record<string, unknown>;
      }

      const current = await readJson<Session>(path);
      if (!current || current.sessionToken !== token.data || !isAllowedFigmaFileKey(current.fileKey) || current.fileKey !== body.fileKey) {
        return NextResponse.json({ error: "Allowlisted plugin session not found or token/file-key mismatch." }, { status: 403, headers });
      }
      if (current.status !== "online" || Date.now() - Date.parse(current.lastHeartbeatAt) >= 75000) {
        return NextResponse.json({ error: "Figma plugin is offline. Open the plugin and try again." }, { status: 409, headers });
      }
      if (current.latestCommand && ["pending", "claimed"].includes(current.latestCommand.status)) {
        const age = Date.now() - Date.parse(current.latestCommand.issuedAt);
        if (Number.isFinite(age) && age < 240000) {
          return NextResponse.json({ error: "A Figma canvas action is already running. Wait for it to finish." }, { status: 409, headers });
        }
      }

      const now = new Date();
      const command: BridgeCommand = {
        commandId: crypto.randomUUID(),
        action: action.data,
        status: "pending",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 240000).toISOString(),
        ...(commandPayload ? { payload: commandPayload } : {}),
      };
      await writeJson(commandPath(clientId), command);
      current.latestCommand = command;
      current.status = "online";
      await writeJson(path, current);
      recordOperationalEvent({
        source: "figma-plugin",
        event: "In-plugin design-agent command queued",
        status: "info",
        summary: action.data === "read-canvas"
          ? "The in-Figma UX Direct agent requested a scoped read of the selected canvas."
          : "The in-Figma UX Direct agent requested a validated native canvas write.",
        requestId: command.commandId,
        action: action.data,
      });
      return NextResponse.json({ ok: true, commandId: command.commandId, status: "pending" }, { headers });
    }

    if (mode === "health-state") {
      const token = z.string().min(20).max(200).safeParse(body.sessionToken);
      if (!token.success) return NextResponse.json({ error: "Session token is missing." }, { status: 400, headers });
      const current = await readJson<Session>(path);
      if (!current || current.sessionToken !== token.data || !isAllowedFigmaFileKey(current.fileKey) || current.fileKey !== body.fileKey) {
        return NextResponse.json({ error: "Allowlisted plugin session not found or token/file-key mismatch." }, { status: 403, headers });
      }
      return NextResponse.json({
        ok: true,
        healthReport: current.healthReport || null,
        lastTestAt: current.lastTestAt || null,
      }, { headers });
    }

    if (mode === "heartbeat") {
      const token = z.string().min(20).max(200).safeParse(body.sessionToken);
      if (!token.success) return NextResponse.json({ error: "Session token is missing." }, { status: 400, headers });
      const current = await readJson<Session>(path);
      if (current && current.sessionToken !== token.data) return NextResponse.json({ error: "Plugin session token mismatch." }, { status: 403, headers });
      if (current && current.fileKey !== body.fileKey) return NextResponse.json({ error: "Plugin session file-key mismatch." }, { status: 403, headers });
      const now = new Date().toISOString();
      const session: Session = {
        clientId, sessionToken: token.data, fileKey: ALLOWED_FIGMA_FILE_KEY, status: "online",
        connectedAt: current?.connectedAt ?? now, lastHeartbeatAt: now,
        lastTestAt: current?.lastTestAt, healthReport: current?.healthReport,
        latestCommand: current?.latestCommand, disconnectedAt: undefined,
      };
      const queued = await readJson<BridgeCommand>(commandPath(clientId));
      let command: BridgeCommand | null = null;
      if (queued && queued.status === "pending" && Date.parse(queued.expiresAt) > Date.now()) {
        command = { ...queued, status: "claimed" };
        command.completedAt = undefined;
        await writeJson(commandPath(clientId), { ...command, claimedAt: now });
        session.latestCommand = command;
      }
      await writeJson(path, session);
      return NextResponse.json({ ok: true, lastHeartbeatAt: now, command }, { headers });
    }

    if (mode === "disconnect") {
      const token = z.string().min(20).max(200).safeParse(body.sessionToken);
      if (!token.success) return NextResponse.json({ error: "Session token is missing." }, { status: 400, headers });
      const current = await readJson<Session>(path);
      if (current && current.sessionToken === token.data && isAllowedFigmaFileKey(current.fileKey) && current.fileKey === body.fileKey) {
        current.status = "offline";
        current.disconnectedAt = new Date().toISOString();
        await writeJson(path, current);
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    if (mode === "canvas-result") {
      const token = z.string().min(20).max(200).safeParse(body.sessionToken);
      const parsedCommandId = ID.safeParse(body.commandId);
      const operationError = typeof body.operationError === "string" ? body.operationError.slice(0, 1000) : "";
      const operationResult = body.operationResult === undefined ? null : body.operationResult;
      const serializedResult = JSON.stringify(operationResult);
      if (!token.success || !parsedCommandId.success || serializedResult.length > 60000) {
        return NextResponse.json({ error: "Canvas result envelope is invalid or too large." }, { status: 400, headers });
      }
      const current = await readJson<Session>(path);
      if (!current || current.sessionToken !== token.data || !isAllowedFigmaFileKey(current.fileKey) || current.fileKey !== body.fileKey) {
        return NextResponse.json({ error: "Allowlisted plugin session not found or token/file-key mismatch." }, { status: 403, headers });
      }
      const command = await readJson<BridgeCommand>(commandPath(clientId));
      if (!command || command.commandId !== parsedCommandId.data || !["read-canvas", "write-canvas"].includes(command.action) || !["pending", "claimed"].includes(command.status)) {
        return NextResponse.json({ error: "This canvas command is no longer active." }, { status: 409, headers });
      }
      const completed: BridgeCommand = {
        ...command,
        status: operationError ? "failed" : "completed",
        completedAt: new Date().toISOString(),
        ...(operationError ? { failure: operationError } : { result: operationResult }),
      };
      await writeJson(commandPath(clientId), completed);
      current.latestCommand = completed;
      current.lastHeartbeatAt = new Date().toISOString();
      current.status = "online";
      await writeJson(path, current);
      recordOperationalEvent({
        source: "figma-plugin",
        event: operationError ? "Figma canvas command failed" : "Figma canvas command completed",
        status: operationError ? "error" : "success",
        summary: operationError ? "A scoped Figma canvas command returned an error." : "A scoped Figma canvas command completed and returned a verified result.",
        category: "Figma Canvas", action: command.action, testType: "functional", requestId: command.commandId,
      });
      return NextResponse.json({ ok: true, saved: true, status: completed.status }, { headers });
    }

    if (mode === "result") {
      const token = z.string().min(20).max(200).safeParse(body.sessionToken);
      const parsedReport = REPORT.safeParse(body.healthReport);
      if (!token.success || !parsedReport.success) return NextResponse.json({ error: "Session token or health report is invalid." }, { status: 400, headers });
      const current = await readJson<Session>(path);
      if (!current || current.sessionToken !== token.data || !isAllowedFigmaFileKey(current.fileKey) || current.fileKey !== body.fileKey) {
        return NextResponse.json({ error: "Allowlisted plugin session not found or token/file-key mismatch." }, { status: 403, headers });
      }
      const commandId = typeof body.commandId === "string" ? body.commandId : undefined;
      if (commandId) {
        const command = await readJson<BridgeCommand>(commandPath(clientId));
        if (!command || command.commandId !== commandId || !["claimed", "pending"].includes(command.status)) {
          return NextResponse.json({ error: "This dashboard command is no longer active." }, { status: 409, headers });
        }
        const completed: BridgeCommand = { ...command, status: "completed", completedAt: new Date().toISOString() };
        await writeJson(commandPath(clientId), completed);
        current.latestCommand = completed;
      }
      current.healthReport = parsedReport.data;
      current.lastTestAt = parsedReport.data.checkedAt;
      current.lastHeartbeatAt = new Date().toISOString();
      current.status = "online";
      await writeJson(path, current);
      await writeJson(latestReportPath, {
        clientId, commandId, savedAt: new Date().toISOString(), healthReport: parsedReport.data,
      } satisfies PersistedHealthReport);
      recordOperationalEvent({
        source: "figma-plugin", event: "Plugin API health check completed",
        status: parsedReport.data.failed > 0 ? "warning" : "success",
        summary: `Figma native API check: ${parsedReport.data.passed} passed, ${parsedReport.data.failed} failed, ${parsedReport.data.available} available, ${parsedReport.data.notTested} not tested.`,
        category: "Native Plugin API", action: commandId ? "Dashboard-triggered health check" : "Plugin-triggered health check",
        testType: "functional", requestId: commandId,
      });
      return NextResponse.json({ ok: true, saved: true }, { headers });
    }

    if (mode === "command") {
      const action = z.enum(["native-api-health-check", "read-canvas", "write-canvas"]).safeParse(body.action);
      if (!action.success) return NextResponse.json({ error: "Unsupported plugin action." }, { status: 400, headers });
      let commandPayload: Record<string, unknown> | undefined;
      if (action.data === "read-canvas") {
        const parsed = CANVAS_READ_PAYLOAD.safeParse(body.payload ?? {});
        if (!parsed.success) return NextResponse.json({ error: "Canvas read options are invalid.", issues: parsed.error.issues }, { status: 400, headers });
        commandPayload = parsed.data;
      }
      if (action.data === "write-canvas") {
        const parsed = CANVAS_WRITE_PAYLOAD.safeParse(body.payload);
        if (!parsed.success) return NextResponse.json({ error: "Canvas write payload is invalid.", issues: parsed.error.issues }, { status: 400, headers });
        commandPayload = parsed.data as unknown as Record<string, unknown>;
      }
      const current = await readJson<Session>(path);
      if (!current || !isAllowedFigmaFileKey(current.fileKey)) return NextResponse.json({ error: "Allowlisted plugin session not found. Open UX Direct in Zunaid_Workspace first." }, { status: 404, headers });
      if (current.status !== "online" || Date.now() - Date.parse(current.lastHeartbeatAt) >= 75000) {
        return NextResponse.json({ error: "Figma plugin is offline. Open the plugin and try again." }, { status: 409, headers });
      }
      if (current.latestCommand && ["pending", "claimed"].includes(current.latestCommand.status)) {
        const commandAgeMs = Date.now() - Date.parse(current.latestCommand.issuedAt);
        if (Number.isFinite(commandAgeMs) && commandAgeMs < 240000) {
          return NextResponse.json({ error: "A plugin action is already running. Wait for it to finish." }, { status: 409, headers });
        }
        current.latestCommand = {
          ...current.latestCommand, status: "failed", completedAt: new Date().toISOString(),
          failure: "Previous native API test stopped responding; stale command lock was cleared."
        };
        await writeJson(path, current);
      }
      const now = new Date();
      const command: BridgeCommand = {
        commandId: crypto.randomUUID(), action: action.data, status: "pending",
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 240000).toISOString(),
        ...(commandPayload ? { payload: commandPayload } : {}),
      };
      await writeJson(commandPath(clientId), command);
      current.latestCommand = command;
      await writeJson(path, current);
      recordOperationalEvent({
        source: "dashboard", event: "Plugin health check command issued", status: "info",
        summary: action.data === "native-api-health-check"
          ? "Dashboard queued a native Figma API health check for the active plugin session."
          : "MCP queued a scoped Figma canvas operation for the active plugin session.",
        requestId: command.commandId, action: action.data,
      });
      return NextResponse.json({ ok: true, commandId: command.commandId, status: "pending" }, { headers });
    }

    return NextResponse.json({ error: "Unsupported bridge mode." }, { status: 400, headers });
  } catch (error) {
    console.error("[ux-direct-bridge] Cloudflare R2 request failed", error);
    return NextResponse.json({ error: "Bridge request failed while reading or writing Cloudflare R2 storage." }, { status: 500, headers });
  }
}
