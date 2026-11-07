import { randomUUID, timingSafeEqual } from "node:crypto";
import { getMcpIssuer, verifyMcpPayload } from "@/lib/mcp-oauth";
import { getChatGPTConnectionStatus, getFigmaPluginConnectionStatus, recordChatGPTActivity } from "@/src/connections/connection-status";
import { NextResponse } from "next/server";
import { addBrainKnowledgeDocument, listBrainFeedback, listBrainKnowledgeDocuments, reviewBrainEvalCase, reviewBrainFeedback, reviewBrainKnowledgeDocument, retrieveBrainContext, runBrainRetrievalEvals, saveBrainEvalCase, saveBrainFeedback } from "@/src/memory/shared-brain";
import { FIGMA_CANVAS_BATCHABLE_STEP_OPERATION_IDS, FIGMA_CANVAS_COMMANDS, FIGMA_CANVAS_OPERATION_IDS, isFigmaCanvasNonBatchableStepOperation } from "@/src/figma-agent/command-registry";
import { BIND_VARIABLE_PROPERTIES, NATIVE_ACTION_EXTENDED_FIELDS, NATIVE_ACTION_EXTENDED_FIELD_KEYS, NATIVE_INSTANCE_ELEMENT_FIELDS, NATIVE_PATCH_EXTENDED_FIELDS, NATIVE_TEXT_RANGE_EXTENDED_FIELDS, extendedActionIssues, nativeJsonSchemaProperties } from "@/src/figma-agent/native-action-schema";

const EXTENDED_ACTION_JSON_PROPERTIES = nativeJsonSchemaProperties(NATIVE_ACTION_EXTENDED_FIELDS);
const EXTENDED_PATCH_JSON_PROPERTIES = nativeJsonSchemaProperties(NATIVE_PATCH_EXTENDED_FIELDS);
const EXTENDED_TEXT_RANGE_JSON_PROPERTIES = nativeJsonSchemaProperties(NATIVE_TEXT_RANGE_EXTENDED_FIELDS);
const INSTANCE_ELEMENT_JSON_PROPERTIES = nativeJsonSchemaProperties(NATIVE_INSTANCE_ELEMENT_FIELDS);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128_000;
const REQUEST_TIMEOUT_MS = 55_000;
const CHATGPT_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type BridgeSession = {
  clientId?: string;
  status?: string;
  isOnline?: boolean;
  lastHeartbeatAt?: string;
  latestCommand?: {
    commandId?: string;
    action?: string;
    status?: string;
    issuedAt?: string;
    completedAt?: string;
    failure?: string;
    result?: unknown;
  };
  healthReport?: {
    passed?: number;
    available?: number;
    failed?: number;
    notTested?: number;
    checkedAt?: string;
    checks?: Array<{ category?: string; name?: string; level?: string; status?: string; reason?: string }>;
  };
};
type BridgeSnapshot = {
  sessions?: BridgeSession[];
  latestReport?: {
    clientId?: string;
    commandId?: string;
    savedAt?: string;
    healthReport?: BridgeSession["healthReport"];
  } | null;
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = origin && (origin === new URL(request.url).origin || CHATGPT_ORIGINS.has(origin));
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Last-Event-ID",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function originIsAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || CHATGPT_ORIGINS.has(origin);
}

type DirectMcpClaims = {
  typ: "access";
  iss?: string;
  aud?: string;
  resource?: string;
  scope?: string;
  exp?: number;
  sub?: string;
};

function bearerValue(request: Request): string {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function authorizedClaims(request: Request): DirectMcpClaims | null {
  const suppliedToken = bearerValue(request);
  if (!suppliedToken) return null;

  // Compatibility fallback for non-ChatGPT service callers. ChatGPT custom MCP
  // connections use the OAuth 2.1 / PKCE flow below.
  const expectedKey = process.env.UX_DIRECT_MCP_API_KEY;
  if (expectedKey && expectedKey.length >= 32) {
    const actual = Buffer.from(suppliedToken);
    const expected = Buffer.from(expectedKey);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      const issuer = getMcpIssuer(request);
      return { typ: "access", iss: issuer, aud: issuer + "/api/mcp", resource: issuer + "/api/mcp", scope: "ux:read ux:execute ux:learn offline_access" };
    }
  }

  const issuer = getMcpIssuer(request);
  const resource = issuer + "/api/mcp";
  const claims = verifyMcpPayload(suppliedToken, "access") as unknown as DirectMcpClaims | null;
  if (!claims || claims.iss !== issuer || (claims.aud !== resource && claims.resource !== resource)) return null;
  return claims;
}

function toolScope(name: string): string {
  if ([
    "ux_direct_brain_save_feedback",
    "ux_direct_brain_review_feedback",
    "ux_direct_brain_add_reference",
    "ux_direct_brain_review_reference",
    "ux_direct_brain_add_eval_case",
    "ux_direct_brain_review_eval_case",
  ].includes(name)) return "ux:learn";
  if ([
    "ux_direct_figma_plugin_queue_health_check",
    "ux_direct_figma_canvas_write",
    "ux_direct_plan_task",
    "ux_direct_brain_run_retrieval_evals",
  ].includes(name)) return "ux:execute";
  return "ux:read";
}

function claimHasScope(claims: DirectMcpClaims, required: string): boolean {
  const granted = new Set(String(claims.scope || "").split(/\s+/).filter(Boolean));
  return granted.has(required) || granted.has("*");
}

function unauthorized(request: Request) {
  const issuer = getMcpIssuer(request);
  const metadata = issuer + "/.well-known/oauth-protected-resource/api/mcp";
  return NextResponse.json(
    { error: "Authentication required. Authorize UX Direct through its OAuth connection flow." },
    { status: 401, headers: {
      "WWW-Authenticate": 'Bearer resource_metadata="' + metadata + '", scope="ux:read ux:execute ux:learn offline_access"',
      "Cache-Control": "no-store",
    }},
  );
}

function rpcResult(id: JsonRpcId, result: unknown, headers: HeadersInit) {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers });
}

function rpcError(id: JsonRpcId, code: number, message: string, headers: HeadersInit) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers });
}

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function fetchBridgeSnapshot(request: Request): Promise<BridgeSnapshot> {
  const response = await fetch(new URL("/api/plugin-bridge?mode=sessions", request.url), {
    method: "GET",
    headers: { accept: "application/json", origin: new URL(request.url).origin },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : "Plugin bridge returned HTTP " + response.status + ".";
    throw new Error(message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Plugin bridge returned an invalid response.");
  }
  return body as BridgeSnapshot;
}

async function postBridgeCommand(request: Request, body: Record<string, unknown>) {
  const origin = new URL(request.url).origin;
  const response = await fetch(new URL("/api/plugin-bridge", request.url), {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json", origin,
      ...(body.mode === "command" && process.env.UX_DIRECT_MCP_OAUTH_SECRET
        ? { "x-ux-direct-internal": process.env.UX_DIRECT_MCP_OAUTH_SECRET }
        : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error
      : "Plugin bridge returned HTTP " + response.status + ".";
    throw new Error(message);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Plugin bridge returned an invalid command response.");
  }
  return result as Record<string, unknown>;
}

async function requireOnlinePluginSession(request: Request) {
  const snapshot = await fetchBridgeSnapshot(request);
  const session = (snapshot.sessions ?? []).find((item) => item.isOnline === true && typeof item.clientId === "string");
  if (!session?.clientId) {
    throw new Error("No active allowlisted Figma plugin session is online. Open UX Direct in the approved Figma file and retry.");
  }
  return session;
}

async function queueFigmaCanvasCommand(
  request: Request,
  action: "read-canvas" | "write-canvas",
  payload: Record<string, unknown>,
) {
  const session = await requireOnlinePluginSession(request);
  const queued = await postBridgeCommand(request, {
    mode: "command", clientId: session.clientId, action, payload,
  });
  return {
    status: "queued",
    commandId: queued.commandId,
    action,
    pluginSession: { clientId: session.clientId, lastHeartbeatAt: session.lastHeartbeatAt ?? null },
    nextStep: "Call ux_direct_figma_canvas_command_status with this commandId to retrieve the verified result.",
    expiresInSeconds: 240,
  };
}

const TOOLS = [
  {
    name: "ux_direct_status",
    description: "Check whether the UX Direct backend is healthy and inspect its non-secret service status. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_connection_status",
    description: "Read-only combined connection diagnostics for the UX Direct backend, recent ChatGPT MCP activity, and the approved Figma plugin heartbeat. Does not queue plugin commands or read the current canvas. ChatGPT activity is recent authenticated activity within five minutes; Figma plugin connectivity is a heartbeat within 75 seconds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_plugin_queue_health_check",
    description: "Queue a controlled native Figma plugin API self-test for the currently online, allowlisted UX Direct plugin session. The test may create or reuse a dedicated persistent 'UXD API Test Lab' page and test fixtures in the approved file. It should not navigate away from or intentionally modify the user's active working page. This is a diagnostic action, not wireframe generation. Use only when the user asks to test the Figma plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_plugin_health_check_status",
    description: "Retrieve the status and report for an already queued native Figma plugin API self-test. This is read-only and does not trigger a new test or canvas command.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]{8,100}$", description: "An existing commandId returned by a prior native plugin API health-check run." },
      },
      required: ["commandId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_canvas_capabilities",
    description: "Return the canonical native Figma command catalogue, including risk, destructive impact, and batch eligibility. Read-only. Check this before planning writes; every write still requires confirm=true, destructive/high-impact operations must match the user's specific request, and commands marked batchable=false must be sent as a standalone operation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_canvas_read",
    description: "Read the currently selected layers or a bounded tree of the active Figma page through the open UX Direct plugin. This queues a native Plugin API command; retrieve the result with ux_direct_figma_canvas_command_status. Reads are limited to the exact allowlisted Figma file and do not mutate the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["selection", "current-page"], description: "Read selected layers or the active page's layer tree." },
        maxDepth: { type: "integer", minimum: 0, maximum: 5, description: "Maximum descendant depth; defaults to 2. Values up to 5 match native Figma final verification." },
        maxNodes: { type: "integer", minimum: 1, maximum: 100, description: "Maximum total nodes returned; defaults to 60." },
        queryName: { type: "string", minLength: 1, maxLength: 120, description: "Optional case-insensitive node-name search across the current page." },
        queryType: { type: "string", minLength: 1, maxLength: 80, description: "Optional Figma node type filter, for example COMPONENT, INSTANCE, TEXT, or FRAME." },
        includePages: { type: "boolean", description: "Include page IDs and names." },
        includeStyles: { type: "boolean", description: "Include compact IDs/names for local paint, text, effect, and grid styles." },
        includeVariables: { type: "boolean", description: "Include bounded local variable names, types, collection names and mode names." },
        includeComponents: { type: "boolean", description: "Include a bounded catalogue of local and in-use components/component sets (IDs, variant and property definitions, use counts) for instance-based edits." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_canvas_write",
    description: "Run explicit, validated native Figma canvas actions through the allowlisted UX Direct plugin. Supports ordered batches of up to 40 actions, frames/shapes/text/vectors/component instances, geometry/typography/solid and gradient fills/strokes/auto-layout (including wrapping existing siblings in Auto Layout)/effects/layout grids/image fills, grouping/flattening/boolean operations, component variants, component properties, instance property overrides and swapping, local style creation and application, variable binding and modes, prototype reactions and flow starts, selection/viewport control, cycle-safe reparenting within the active page, page creation/rename/switching, SVG/PNG/PDF export. Every write requires confirm=true and is audited; deletion is limited to a node on the current page. No arbitrary code execution, unrestricted document traversal, library publishing, or bulk replacement. Retrieve verified results with ux_direct_figma_canvas_command_status.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: FIGMA_CANVAS_OPERATION_IDS },
        confirm: { type: "boolean", const: true, description: "Must be true only after the owner explicitly requests this specific write." },
        target: { type: "string", enum: ["current-page", "selection", "node", "test-lab"] },
        elements: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "SLICE", "VECTOR", "INSTANCE"] },
              ...INSTANCE_ELEMENT_JSON_PROPERTIES,
              name: { type: "string", minLength: 1, maxLength: 80 },
              x: { type: "number", minimum: -10000, maximum: 10000 },
              y: { type: "number", minimum: -10000, maximum: 10000 },
              width: { type: "number", minimum: 1, maximum: 4096 },
              height: { type: "number", minimum: 1, maximum: 4096 },
              text: { type: "string", maxLength: 5000 },
              fontSize: { type: "number", minimum: 8, maximum: 144 },
              color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
              strokeColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
              strokeWeight: { type: "number", minimum: 0, maximum: 100 },
              opacity: { type: "number", minimum: 0, maximum: 1 },
              rotation: { type: "number", minimum: -360, maximum: 360 },
              arcData: {
                type: "object",
                properties: {
                  startingAngle: { type: "number", minimum: -6.283185307179586, maximum: 6.283185307179586 },
                  endingAngle: { type: "number", minimum: -6.283185307179586, maximum: 6.283185307179586 },
                  innerRadius: { type: "number", minimum: 0, maximum: 1 }
                },
                required: ["startingAngle", "endingAngle", "innerRadius"],
                additionalProperties: false,
                description: "Optional native Figma ellipse arc for progress rings; angles are radians and endingAngle must exceed startingAngle."
              },
              cornerRadius: { type: "number", minimum: 0, maximum: 512 },
              clipsContent: { type: "boolean" },
              layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL", "GRID"] },
              layoutWrap: { type: "string", enum: ["NO_WRAP", "WRAP"] },
              layoutSizingHorizontal: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
              layoutSizingVertical: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
              layoutPositioning: { type: "string", enum: ["AUTO", "ABSOLUTE"] },
              layoutGrow: { type: "number", minimum: 0, maximum: 1 },
              itemSpacing: { type: "number", minimum: -100, maximum: 1000 },
              fontFamily: { type: "string", minLength: 1, maxLength: 100 },
              fontStyle: { type: "string", minLength: 1, maxLength: 100 },
              paddingLeft: { type: "number", minimum: 0, maximum: 1000 },
              paddingRight: { type: "number", minimum: 0, maximum: 1000 },
              paddingTop: { type: "number", minimum: 0, maximum: 1000 },
              paddingBottom: { type: "number", minimum: 0, maximum: 1000 },
              primaryAxisAlignItems: { type: "string", enum: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"] },
              counterAxisAlignItems: { type: "string", enum: ["MIN", "MAX", "CENTER", "BASELINE"] },
              primaryAxisSizingMode: { type: "string", enum: ["AUTO", "FIXED"] },
              counterAxisSizingMode: { type: "string", enum: ["AUTO", "FIXED"] },
              textAlignHorizontal: { type: "string", enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] },
              textAlignVertical: { type: "string", enum: ["TOP", "CENTER", "BOTTOM"] },
              textAutoResize: { type: "string", enum: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"] },
              lineHeight: { type: "object", properties: { unit: { type: "string", enum: ["PIXELS", "PERCENT"] }, value: { type: "number", minimum: 1, maximum: 500 } }, required: ["unit", "value"], additionalProperties: false },
              letterSpacing: { type: "object", properties: { unit: { type: "string", enum: ["PIXELS", "PERCENT"] }, value: { type: "number", minimum: -100, maximum: 500 } }, required: ["unit", "value"], additionalProperties: false },
            textCase: { type: "string", enum: ["ORIGINAL", "UPPER", "LOWER", "TITLE"] },
            textDecoration: { type: "string", enum: ["NONE", "UNDERLINE", "STRIKETHROUGH"] },
              shadowColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
              shadowBlur: { type: "number", minimum: 0, maximum: 200 },
              shadowX: { type: "number", minimum: -200, maximum: 200 },
              shadowY: { type: "number", minimum: -200, maximum: 200 },
              shadowSpread: { type: "number", minimum: -200, maximum: 200 },
              pointCount: { type: "integer", minimum: 3, maximum: 100 },
              innerRadius: { type: "number", minimum: 0.01, maximum: 1 },
              vectorPaths: {
                type: "array", minItems: 1, maxItems: 5,
                items: {
                  type: "object",
                  properties: {
                    windingRule: { type: "string", enum: ["EVENODD", "NONZERO"] },
                    data: { type: "string", minLength: 1, maxLength: 5000 }
                  },
                  required: ["windingRule", "data"],
                  additionalProperties: false
                }
              }
            },
            required: ["type", "name"],
            additionalProperties: false
          }
        },
        nodeId: { type: "string", minLength: 1, maxLength: 100 },
        parentNodeId: { type: "string", minLength: 1, maxLength: 100 },
        pageId: { type: "string", minLength: 1, maxLength: 100 },
        actions: {
          type: "array", minItems: 1, maxItems: 40,
          description: "Sequential canvas actions. Batch is non-atomic: completed earlier steps remain if a later action fails. Large exports must be standalone steps.",
          items: {
            type: "object",
            properties: {
              operation: { type: "string", enum: FIGMA_CANVAS_BATCHABLE_STEP_OPERATION_IDS },
              target: { type: "string", enum: ["current-page", "selection", "node", "test-lab"] },
              nodeId: { type: "string", minLength: 1, maxLength: 100 },
        parentNodeId: { type: "string", minLength: 1, maxLength: 100 },
        pageId: { type: "string", minLength: 1, maxLength: 100 },
              nodeIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 100 },
              index: { type: "integer", minimum: 0, maximum: 10000 },
              pageName: { type: "string", minLength: 1, maxLength: 120 },
              styleKind: { type: "string", enum: ["paint", "text", "effect", "grid"] },
              styleId: { type: "string", minLength: 1, maxLength: 300 },
              styleName: { type: "string", minLength: 1, maxLength: 240 },
              booleanOperation: { type: "string", enum: ["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"] },
              componentId: { type: "string", minLength: 1, maxLength: 100 },
              format: { type: "string", enum: ["PNG", "PDF", "SVG_STRING"] },
              range: {
                type: "object",
                properties: {
                  start: { type: "integer", minimum: 0, maximum: 5000 },
                  end: { type: "integer", minimum: 1, maximum: 5000 },
                  fontSize: { type: "number", minimum: 8, maximum: 144 },
                  lineHeight: { type: "object", properties: { unit: { type: "string", enum: ["PIXELS", "PERCENT"] }, value: { type: "number", minimum: 1, maximum: 500 } }, required: ["unit", "value"], additionalProperties: false },
                  letterSpacing: { type: "object", properties: { unit: { type: "string", enum: ["PIXELS", "PERCENT"] }, value: { type: "number", minimum: -100, maximum: 500 } }, required: ["unit", "value"], additionalProperties: false },
                  fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
                  ...EXTENDED_TEXT_RANGE_JSON_PROPERTIES
                },
                required: ["start", "end"],
                additionalProperties: false
              },
              imageBase64: { type: "string", maxLength: 250000 },
              scaleMode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"] },
              elements: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: true } },
              patch: { type: "object", additionalProperties: true },
              collectionName: { type: "string", minLength: 1, maxLength: 100 },
              modeName: { type: "string", minLength: 1, maxLength: 100 },
              variableName: { type: "string", minLength: 1, maxLength: 100 },
              property: { type: "string", enum: BIND_VARIABLE_PROPERTIES },
              ...EXTENDED_ACTION_JSON_PROPERTIES
            },
            required: ["operation"],
            additionalProperties: false
          }
        },
        patch: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            visible: { type: "boolean" },
            x: { type: "number", minimum: -10000, maximum: 10000 },
            y: { type: "number", minimum: -10000, maximum: 10000 },
            width: { type: "number", minimum: 1, maximum: 4096 },
            height: { type: "number", minimum: 1, maximum: 4096 },
            rotation: { type: "number", minimum: -360, maximum: 360 },
            opacity: { type: "number", minimum: 0, maximum: 1 },
            fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            strokeColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            strokeWeight: { type: "number", minimum: 0, maximum: 100 },
            cornerRadius: { type: "number", minimum: 0, maximum: 512 },
            clipsContent: { type: "boolean" },
            text: { type: "string", maxLength: 5000 },
            fontFamily: { type: "string", minLength: 1, maxLength: 100 },
            fontStyle: { type: "string", minLength: 1, maxLength: 100 },
            fontSize: { type: "number", minimum: 8, maximum: 144 },
            textAlignHorizontal: { type: "string", enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] },
            textAlignVertical: { type: "string", enum: ["TOP", "CENTER", "BOTTOM"] },
            textAutoResize: { type: "string", enum: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"] },
            layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL", "GRID"] },
            itemSpacing: { type: "number", minimum: -100, maximum: 1000 },
            paddingLeft: { type: "number", minimum: 0, maximum: 1000 },
            paddingRight: { type: "number", minimum: 0, maximum: 1000 },
            paddingTop: { type: "number", minimum: 0, maximum: 1000 },
            paddingBottom: { type: "number", minimum: 0, maximum: 1000 },
            primaryAxisAlignItems: { type: "string", enum: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"] },
            counterAxisAlignItems: { type: "string", enum: ["MIN", "MAX", "CENTER", "BASELINE"] },
            primaryAxisSizingMode: { type: "string", enum: ["AUTO", "FIXED"] },
            counterAxisSizingMode: { type: "string", enum: ["AUTO", "FIXED"] },
            horizontalConstraint: { type: "string", enum: ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"] },
            verticalConstraint: { type: "string", enum: ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"] },
            textCase: { type: "string", enum: ["ORIGINAL", "UPPER", "LOWER", "TITLE"] },
            textDecoration: { type: "string", enum: ["NONE", "UNDERLINE", "STRIKETHROUGH"] },
            shadowColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            shadowBlur: { type: "number", minimum: 0, maximum: 200 },
            shadowX: { type: "number", minimum: -200, maximum: 200 },
            shadowY: { type: "number", minimum: -200, maximum: 200 },
            shadowSpread: { type: "number", minimum: -200, maximum: 200 },
            ...EXTENDED_PATCH_JSON_PROPERTIES
          },
          additionalProperties: false
        },
        nodeIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 100 },
        index: { type: "integer", minimum: 0, maximum: 10000 },
        pageName: { type: "string", minLength: 1, maxLength: 120 },
        styleKind: { type: "string", enum: ["paint", "text", "effect", "grid"] },
        styleId: { type: "string", minLength: 1, maxLength: 300 },
        styleName: { type: "string", minLength: 1, maxLength: 240 },
        booleanOperation: { type: "string", enum: ["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"] },
        componentId: { type: "string", minLength: 1, maxLength: 100 },
        format: { type: "string", enum: ["PNG", "PDF", "SVG_STRING"] },
        range: {
          type: "object",
          properties: {
            start: { type: "integer", minimum: 0, maximum: 5000 },
            end: { type: "integer", minimum: 1, maximum: 5000 },
            fontSize: { type: "number", minimum: 8, maximum: 144 },
            lineHeight: { type: "object", properties: { unit: { type: "string", enum: ["PIXELS", "PERCENT"] }, value: { type: "number", minimum: 1, maximum: 500 } }, required: ["unit", "value"], additionalProperties: false },
            letterSpacing: { type: "object", properties: { unit: { type: "string", enum: ["PIXELS", "PERCENT"] }, value: { type: "number", minimum: -100, maximum: 500 } }, required: ["unit", "value"], additionalProperties: false },
            fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            ...EXTENDED_TEXT_RANGE_JSON_PROPERTIES
          },
          required: ["start", "end"],
          additionalProperties: false
        },
        imageBase64: { type: "string", maxLength: 250000 },
        scaleMode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"] },
        name: { type: "string", minLength: 1, maxLength: 100 },
        x: { type: "number", minimum: -10000, maximum: 10000 },
        y: { type: "number", minimum: -10000, maximum: 10000 },
        width: { type: "number", minimum: 1, maximum: 4096 },
        height: { type: "number", minimum: 1, maximum: 4096 },
        cornerRadius: { type: "number", minimum: 0, maximum: 512 },
        layoutPositioning: { type: "string", enum: ["AUTO", "ABSOLUTE"] },
        layoutSizingHorizontal: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
        layoutSizingVertical: { type: "string", enum: ["FIXED", "HUG", "FILL"] },
        collectionName: { type: "string", minLength: 1, maxLength: 100 },
        modeName: { type: "string", minLength: 1, maxLength: 100 },
        variables: { type: "array", maxItems: 80, items: { type: "object", properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          type: { type: "string", enum: ["COLOR", "FLOAT", "STRING", "BOOLEAN"] },
          value: { oneOf: [{ type: "string", maxLength: 300 }, { type: "number" }, { type: "boolean" }] }
        }, required: ["name", "type", "value"], additionalProperties: false } },
        variableName: { type: "string", minLength: 1, maxLength: 100 },
        property: { type: "string", enum: BIND_VARIABLE_PROPERTIES },
        ...EXTENDED_ACTION_JSON_PROPERTIES
      },
      required: ["operation", "confirm"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_canvas_command_status",
    description: "Retrieve the status, failure reason or actual result of a queued Figma canvas read/write command. Requires a commandId returned by ux_direct_figma_canvas_read or ux_direct_figma_canvas_write.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]{8,100}$" }
      },
      required: ["commandId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_plan_task",
    description: "Ask UX Direct for a reviewable UX task plan. Planning only: this does not edit Figma or execute external writes. Use 'general' for BFSI website revamp and other general UX tasks, or 'express-computers' for Express Computers work. DMI-specific project data is not exposed through this connector.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160, description: "Short task name." },
        request: { type: "string", minLength: 5, maxLength: 8000, description: "Requirements, constraints, context, expected screens, and review criteria." },
        project: { type: "string", enum: ["general", "express-computers"], description: "Use general for BFSI website revamp work." },
      },
      required: ["title", "request", "project"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ux_direct_brain_search",
    description: "Retrieve approved, scope-filtered memories and reference chunks from the shared product brain. Use this before UX planning, audits, benchmarking, Figma screen critique, or when checking whether a reusable rule already exists. Retrieval is cheap Postgres full-text/tag matching and makes no model call. Never use a client's private findings as shared memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 8000 },
        scopeKeys: { type: "array", items: { type: "string", enum: ["UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:ux-audit", "project:general-ux", "project:dmi-finance", "project:ujjivan-sfb", "project:express-computers"] }, maxItems: 8 },
        limit: { type: "integer", minimum: 1, maximum: 12 },
        maxChars: { type: "integer", minimum: 600, maximum: 5200 },
        includeKnowledge: { type: "boolean" }
      },
      required: ["query"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_save_feedback",
    description: "Internal coaching tool. Capture reusable corrections and explicit learning signals in Hindi/Hinglish/English, preserve original wording, and normalize the lesson with rationale, scope, keywords, and examples. Eligible material is automatically activated after deterministic relevance (>=50%) and scope checks; no manual approval is required. Skip ordinary chat and likely secrets. Never promote client-specific evidence into global scope.",
    inputSchema: {
      type: "object",
      properties: {
        rawFeedback: { type: "string", minLength: 1, maxLength: 12000 },
        summary: { type: "string", maxLength: 1200 },
        title: { type: "string", minLength: 1, maxLength: 180 },
        normalizedRule: { type: "string", minLength: 1, maxLength: 2400 },
        rationale: { type: "string", maxLength: 1800 },
        scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN", "indian-bfsi", "project:ux-direct", "project:ux-audit", "project:general-ux", "project:dmi-finance", "project:ujjivan-sfb", "project:express-computers"] },
        feedbackKind: { type: "string", enum: ["general","false_positive","missed_issue","severity_calibration","recommendation_quality","duplicate_finding","benchmarking","scope","visual_evidence","accessibility","interaction_logic","design_system","cost_optimization","other"] },
        keywords: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 32 },
        examples: { type: "array", items: {}, maxItems: 8 },
        originalLanguage: { type: "string", maxLength: 60 },
        sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"] },
        sourceAuditRef: { type: "string", maxLength: 120 },
        sourceFindingTitle: { type: "string", maxLength: 240 },
        idempotencyKey: { type: "string", maxLength: 180 }
      },
      required: ["rawFeedback","title","normalizedRule","sourceProduct"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_list_feedback",
    description: "List draft/approved/rejected/archived coaching feedback in the shared brain. Use when reviewing a correction or locating its feedbackId before approval. This does not change the live memory library.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["all","draft","approved","rejected","archived"] }, sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_review_feedback",
    description: "Manage coaching lessons: approve legacy drafts, or reject/archive incorrect, stale, or out-of-scope lessons. New eligible lessons activate automatically after relevance and scope checks. Activation adds retrievable context; it does not fine-tune model weights.",
    inputSchema: { type: "object", properties: { feedbackId: { type: "string", format: "uuid" }, decision: { type: "string", enum: ["approve","reject","archive"] }, reviewNote: { type: "string", maxLength: 1000 }, sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"] } }, required: ["feedbackId","decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_add_reference",
    description: "Add reusable UX, design-system, accessibility, interaction, cost, or Indian BFSI reference material. Documents with at least 50% deterministic UX/product relevance are chunked and automatically activated after scope checks and successful writes; no human approval is required. Record relevance metadata. Do not bulk-import client-specific Past Findings or confidential client artifacts into global scope.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 240 }, content: { type: "string", minLength: 1, maxLength: 100000 }, projectKey: { type: "string", enum: ["UX_SHARED_BRAIN","indian-bfsi","project:ux-direct","project:ux-audit","project:general-ux","project:dmi-finance","project:ujjivan-sfb","project:express-computers"] }, sourceUrl: { type: "string", format: "uri", maxLength: 1800 }, sourceType: { type: "string", maxLength: 60 }, sourceAuthority: { type: "string", maxLength: 60 }, sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"] } }, required: ["title","content"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_list_references",
    description: "List reference documents and their ingestion status and relevance metadata in the shared product brain.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["all","draft","approved","rejected","archived","failed"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_review_reference",
    description: "Reject or archive a problematic reference to remove it from future retrieval; approval remains available for legacy drafts. Only approved, in-scope documents are included in model context.",
    inputSchema: { type: "object", properties: { documentId: { type: "string", format: "uuid" }, decision: { type: "string", enum: ["approve","reject","archive"] } }, required: ["documentId","decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_add_eval_case",
    description: "Add a deterministic retrieval/quality regression case for future shared-brain evaluation. Provide expected memory UUIDs where possible and forbidden output phrases. Saves as draft; approve after review. Does not call an AI model.",
    inputSchema: { type: "object", properties: { scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","indian-bfsi","project:ux-direct","project:ux-audit","project:general-ux","project:dmi-finance","project:ujjivan-sfb","project:express-computers"] }, capability: { type: "string", maxLength: 100 }, title: { type: "string", minLength: 1, maxLength: 200 }, input: { type: "string", minLength: 1, maxLength: 4000 }, expectedBehavior: { type: "string", minLength: 1, maxLength: 2000 }, forbiddenBehaviors: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 20 }, expectedMemoryIds: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 30 } }, required: ["title","input","expectedBehavior"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_review_eval_case",
    description: "Approve/reject/archive a shared-brain retrieval regression case. Only approved cases run in evaluation.",
    inputSchema: { type: "object", properties: { caseId: { type: "string", format: "uuid" }, decision: { type: "string", enum: ["approve","reject","archive"] } }, required: ["caseId","decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_run_retrieval_evals",
    description: "Run deterministic tests against approved brain retrieval cases; reports recall and forbidden phrase matches. Uses no model inference and should be preferred for routine regression checks.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
];

async function callTool(name: string, args: unknown, request: Request) {
  if (name === "ux_direct_status") {
    const response = await fetch(new URL("/api/health", request.url), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({ error: "UX Direct health endpoint returned invalid JSON." }));
    return response.ok ? toolText(body) : toolText({ status: response.status, body }, true);
  }

  if (name === "ux_direct_connection_status") {
    const [chatgptConnector, figmaPlugin, backendResponse] = await Promise.all([
      getChatGPTConnectionStatus(),
      getFigmaPluginConnectionStatus(),
      fetch(new URL("/api/health", request.url), {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    const backend = await backendResponse.json().catch(() => ({ error: "Health endpoint returned invalid JSON." }));
    return toolText({
      checkedAt: new Date().toISOString(),
      backend: { reachable: backendResponse.ok, status: backendResponse.ok ? "connected" : "error", details: backend },
      chatgptConnector: {
        state: chatgptConnector.state,
        connected: chatgptConnector.connected,
        lastActivityAt: chatgptConnector.lastActivityAt,
        note: "Connected means authenticated ChatGPT MCP activity was received in the last five minutes. Idle means no recent request; it is not a persistent-socket failure.",
      },
      figmaPlugin: {
        state: figmaPlugin.state,
        connected: figmaPlugin.connected,
        connectedSessions: figmaPlugin.connectedSessions,
        lastHeartbeatAt: figmaPlugin.lastHeartbeatAt,
        note: "Connected means an approved Figma plugin session sent a heartbeat in the last 75 seconds.",
      },
      controlPlane: {
        mode: "full-control",
        note: "This connection check is read-only. Authorized MCP clients can also queue scoped Figma canvas reads, confirmed writes, plugin health checks and task plans; verify every queued action by its command ID.",
      },
    });
  }

  if (name === "ux_direct_figma_plugin_queue_health_check") {
    const snapshot = await fetchBridgeSnapshot(request);
    const session = (snapshot.sessions ?? []).find((item) => item.isOnline === true && typeof item.clientId === "string");
    if (!session?.clientId) {
      return toolText({
        status: "offline",
        error: "No active allowlisted Figma plugin session is online. Open the UX Direct plugin in the approved Figma file and retry.",
      }, true);
    }
    try {
      const queued = await postBridgeCommand(request, {
        mode: "command",
        clientId: session.clientId,
        action: "native-api-health-check",
      });
      return toolText({
        status: "queued",
        commandId: queued.commandId,
        pluginSession: {
          clientId: session.clientId,
          lastHeartbeatAt: session.lastHeartbeatAt ?? null,
        },
        sideEffects: "Runs the native API self-test in the dedicated UXD API Test Lab page and stores its report. It does not generate, move, or rearrange production UI.",
        nextStep: "Call ux_direct_figma_plugin_health_check_status with this commandId to retrieve progress and results.",
      });
    } catch (error) {
      return toolText({ status: "error", error: error instanceof Error ? error.message : "Could not queue the Figma plugin health check." }, true);
    }
  }

  if (name === "ux_direct_figma_plugin_health_check_status") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be a JSON object." }, true);
    const input = args as Record<string, unknown>;
    const commandId = typeof input.commandId === "string" ? input.commandId.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(commandId)) {
      return toolText({ error: "Provide the commandId returned by ux_direct_figma_plugin_queue_health_check." }, true);
    }
    const snapshot = await fetchBridgeSnapshot(request);
    const session = (snapshot.sessions ?? []).find((item) => item.latestCommand?.commandId === commandId);
    const latestReport = snapshot.latestReport?.commandId === commandId ? snapshot.latestReport : null;
    const report = latestReport?.healthReport ?? session?.healthReport ?? null;
    if (!session && !latestReport) {
      return toolText({
        commandId,
        status: "not_found",
        message: "No matching active command or latest report was found. The command may have expired or been superseded by a newer plugin test.",
      });
    }
    return toolText({
      commandId,
      operation: session?.latestCommand?.action ?? null,
      status: session?.latestCommand?.status ?? (latestReport ? "completed" : "unknown"),
      issuedAt: session?.latestCommand?.issuedAt ?? null,
      completedAt: session?.latestCommand?.completedAt ?? latestReport?.savedAt ?? null,
      failure: session?.latestCommand?.failure ?? null,
      canvasResult: session?.latestCommand?.action === "read-canvas" && session.latestCommand.status === "completed"
        ? session.latestCommand.result ?? null
        : null,
      pluginSession: session ? {
        clientId: session.clientId,
        isOnline: session.isOnline === true,
        lastHeartbeatAt: session.lastHeartbeatAt ?? null,
      } : latestReport ? { clientId: latestReport.clientId ?? null } : null,
      healthReport: report ? {
        passed: report.passed ?? 0,
        available: report.available ?? 0,
        failed: report.failed ?? 0,
        notTested: report.notTested ?? 0,
        checkedAt: report.checkedAt ?? null,
        checks: (report.checks ?? []).slice(0, 60),
      } : null,
    });
  }

  if (name === "ux_direct_figma_canvas_capabilities") {
    return toolText({
      commands: FIGMA_CANVAS_COMMANDS,
      policy: {
        everyWriteRequiresExplicitConfirm: true,
        destructiveAndHighImpactOperationsRequireSpecificUserIntent: true,
        nonBatchableOperationsMustRunAlone: true,
        maxActionsPerBatch: 40,
        maxCreatedNodesPerBatch: 100,
        fileScope: "exact allowlisted Figma file",
        execution: "native Figma Plugin API through the active scoped plugin session",
        verification: "check ux_direct_figma_canvas_command_status and native readback before reporting success",
      },
    });
  }

  if (name === "ux_direct_figma_canvas_read") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const scope = input.scope === undefined ? "selection" : input.scope;
    const maxDepth = input.maxDepth === undefined ? 2 : input.maxDepth;
    const maxNodes = input.maxNodes === undefined ? 60 : input.maxNodes;
    const queryName = input.queryName;
    const queryType = input.queryType;
    const includePages = input.includePages === true;
    const includeStyles = input.includeStyles === true;
    const includeVariables = input.includeVariables === true;
    const includeComponents = input.includeComponents === true;
    if (scope !== "selection" && scope !== "current-page") return toolText({ error: "scope must be selection or current-page." }, true);
    if (!Number.isInteger(maxDepth) || (maxDepth as number) < 0 || (maxDepth as number) > 5) return toolText({ error: "maxDepth must be an integer from 0 to 5." }, true);
    if (!Number.isInteger(maxNodes) || (maxNodes as number) < 1 || (maxNodes as number) > 100) return toolText({ error: "maxNodes must be an integer from 1 to 100." }, true);
    if (queryName !== undefined && (typeof queryName !== "string" || !queryName.trim() || queryName.length > 120)) return toolText({ error: "queryName must be a non-empty string up to 120 characters." }, true);
    if (queryType !== undefined && (typeof queryType !== "string" || !queryType.trim() || queryType.length > 80)) return toolText({ error: "queryType must be a non-empty string up to 80 characters." }, true);
    if (input.includePages !== undefined && typeof input.includePages !== "boolean") return toolText({ error: "includePages must be boolean." }, true);
    if (input.includeStyles !== undefined && typeof input.includeStyles !== "boolean") return toolText({ error: "includeStyles must be boolean." }, true);
    if (input.includeVariables !== undefined && typeof input.includeVariables !== "boolean") return toolText({ error: "includeVariables must be boolean." }, true);
    if (input.includeComponents !== undefined && typeof input.includeComponents !== "boolean") return toolText({ error: "includeComponents must be boolean." }, true);
    try {
      return toolText(await queueFigmaCanvasCommand(request, "read-canvas", {
        scope, maxDepth, maxNodes,
        ...(queryName === undefined ? {} : { queryName }),
        ...(queryType === undefined ? {} : { queryType }),
        includePages, includeStyles, includeVariables, includeComponents,
      }));
    } catch (error) {
      return toolText({ status: "error", error: error instanceof Error ? error.message : "Could not queue Figma canvas read." }, true);
    }
  }

  if (name === "ux_direct_figma_canvas_write") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const allowedOperations = new Set<string>(FIGMA_CANVAS_OPERATION_IDS);
    if (input.confirm !== true) return toolText({ error: "Write blocked: confirm=true is required after an explicit request for this specific canvas action." }, true);
    if (typeof input.operation !== "string" || !allowedOperations.has(input.operation)) {
      return toolText({ error: "operation is not a supported Figma canvas action." }, true);
    }
    const payload: Record<string, unknown> = {
      operation: input.operation, confirm: true,
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.elements === undefined ? {} : { elements: input.elements }),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.parentNodeId === undefined ? {} : { parentNodeId: input.parentNodeId }),
      ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
      ...(input.nodeIds === undefined ? {} : { nodeIds: input.nodeIds }),
      ...(input.index === undefined ? {} : { index: input.index }),
      ...(input.pageName === undefined ? {} : { pageName: input.pageName }),
      ...(input.styleKind === undefined ? {} : { styleKind: input.styleKind }),
      ...(input.styleId === undefined ? {} : { styleId: input.styleId }),
      ...(input.styleName === undefined ? {} : { styleName: input.styleName }),
      ...(input.booleanOperation === undefined ? {} : { booleanOperation: input.booleanOperation }),
      ...(input.componentId === undefined ? {} : { componentId: input.componentId }),
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.scale === undefined ? {} : { scale: input.scale }),
      ...(input.range === undefined ? {} : { range: input.range }),
      ...(input.imageBase64 === undefined ? {} : { imageBase64: input.imageBase64 }),
      ...(input.scaleMode === undefined ? {} : { scaleMode: input.scaleMode }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.x === undefined ? {} : { x: input.x }),
      ...(input.y === undefined ? {} : { y: input.y }),
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.cornerRadius === undefined ? {} : { cornerRadius: input.cornerRadius }),
      ...(input.layoutPositioning === undefined ? {} : { layoutPositioning: input.layoutPositioning }),
      ...(input.layoutSizingHorizontal === undefined ? {} : { layoutSizingHorizontal: input.layoutSizingHorizontal }),
      ...(input.layoutSizingVertical === undefined ? {} : { layoutSizingVertical: input.layoutSizingVertical }),
      ...(input.collectionName === undefined ? {} : { collectionName: input.collectionName }),
      ...(input.modeName === undefined ? {} : { modeName: input.modeName }),
      ...(input.variables === undefined ? {} : { variables: input.variables }),
      ...(input.variableName === undefined ? {} : { variableName: input.variableName }),
      ...(input.property === undefined ? {} : { property: input.property }),
      ...(input.patch === undefined ? {} : { patch: input.patch }),
      ...(input.actions === undefined ? {} : { actions: input.actions }),
      ...Object.fromEntries(NATIVE_ACTION_EXTENDED_FIELD_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
    };
    const extendedIssue = extendedActionIssues(input as Parameters<typeof extendedActionIssues>[0])[0];
    if (extendedIssue) return toolText({ error: extendedIssue.message }, true);
    if (input.target !== undefined && !["current-page", "selection", "node", "test-lab"].includes(String(input.target))) {
      return toolText({ error: "target must be current-page, selection, node, or test-lab." }, true);
    }
    if (input.operation === "batch" && (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 40)) return toolText({ error: "batch requires 1–40 actions." }, true);
    if (input.operation === "batch" && Array.isArray(input.actions) && input.actions.some((step) => step && typeof step === "object" && isFigmaCanvasNonBatchableStepOperation((step as Record<string, unknown>).operation))) return toolText({ error: "Operations marked batchable=false must be sent as standalone commands, not through batch." }, true);
    if (input.operation !== "batch" && input.actions !== undefined) return toolText({ error: "actions is supported only for batch." }, true);
    if (input.operation === "batch" && Array.isArray(input.actions)) {
      const totalCreated = input.actions.reduce((sum, step) => {
        if (!step || typeof step !== "object" || Array.isArray(step)) return sum;
        const action = step as Record<string, unknown>;
        return sum + (action.operation === "create-elements" && Array.isArray(action.elements) ? action.elements.length : 0);
      }, 0);
      if (totalCreated > 100) return toolText({ error: "A batch can create at most 100 canvas nodes in total." }, true);
    }
    if (input.operation === "create-elements") {
      if (!Array.isArray(input.elements) || input.elements.length < 1 || input.elements.length > 20) {
        return toolText({ error: "create-elements requires 1–20 elements." }, true);
      }
      const allowedTypes = new Set(["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "SLICE", "VECTOR", "INSTANCE"]);
      for (const item of input.elements) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return toolText({ error: "Each element must be an object." }, true);
        const element = item as Record<string, unknown>;
        if (!allowedTypes.has(String(element.type)) || typeof element.name !== "string" || !element.name.trim()) {
          return toolText({ error: "Each element requires a supported type and non-empty name." }, true);
        }
        if (element.type === "TEXT" && typeof element.text !== "string") return toolText({ error: "TEXT elements require text content." }, true);
        if (element.type === "INSTANCE" && typeof element.componentId !== "string") return toolText({ error: "INSTANCE elements require componentId." }, true);
        if (element.type === "VECTOR" && (!Array.isArray(element.vectorPaths) || element.vectorPaths.length < 1)) return toolText({ error: "VECTOR elements require vectorPaths." }, true);
      }
    }
    if (input.operation === "insert-image" && (typeof input.imageBase64 !== "string" || !input.imageBase64.length || !input.target)) return toolText({ error: "insert-image requires imageBase64 and target." }, true);
    if (input.operation === "create-variables" && (typeof input.collectionName !== "string" || !Array.isArray(input.variables) || !input.variables.length)) return toolText({ error: "create-variables requires collectionName and variables." }, true);
    if (input.operation === "bind-variable" && (typeof input.nodeId !== "string" || typeof input.variableName !== "string" || typeof input.property !== "string")) return toolText({ error: "bind-variable requires nodeId, variableName and property." }, true);
    if (input.operation === "update-node") {
      if (typeof input.nodeId !== "string" || !input.nodeId.trim()) return toolText({ error: "update-node requires nodeId." }, true);
      if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch) || !Object.keys(input.patch as Record<string, unknown>).length) {
        return toolText({ error: "update-node requires a non-empty patch." }, true);
      }
    }
    const nodeRequired = new Set(["clone-node", "delete-node", "reorder-node", "reparent-node", "ungroup-node", "create-component", "create-instance", "swap-component", "detach-instance", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill", "bind-variable"]);
    if (nodeRequired.has(input.operation) && (typeof input.nodeId !== "string" || !input.nodeId.trim())) {
      return toolText({ error: input.operation + " requires nodeId." }, true);
    }
    if ((input.operation === "flatten-nodes" || input.operation === "boolean-operation") && (!Array.isArray(input.nodeIds) || input.nodeIds.length < (input.operation === "flatten-nodes" ? 1 : 2) || input.nodeIds.length > 100)) {
      return toolText({ error: input.operation + " requires nodeIds." }, true);
    }
    if (input.operation === "boolean-operation" && !["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"].includes(String(input.booleanOperation))) {
      return toolText({ error: "boolean-operation requires UNION, SUBTRACT, INTERSECT, or EXCLUDE." }, true);
    }
    if (input.operation === "create-component-set" && (!Array.isArray(input.nodeIds) || input.nodeIds.length < 2 || input.nodeIds.length > 100)) {
      return toolText({ error: "create-component-set requires at least two component IDs." }, true);
    }
    if (input.operation === "swap-component" && (typeof input.componentId !== "string" || !input.componentId.trim())) return toolText({ error: "swap-component requires componentId." }, true);
    if (input.operation === "set-text-range" && (!input.range || typeof input.range !== "object" || Array.isArray(input.range))) return toolText({ error: "set-text-range requires a range object." }, true);
    if (input.operation === "export-node" && !["PNG", "PDF", "SVG_STRING"].includes(String(input.format))) return toolText({ error: "export-node requires format PNG, PDF, or SVG_STRING." }, true);
    if (input.operation === "create-image-fill" && (typeof input.imageBase64 !== "string" || !input.imageBase64.length)) return toolText({ error: "create-image-fill requires imageBase64." }, true);
    if (input.operation === "reparent-node" && (typeof input.parentNodeId !== "string" || !input.parentNodeId.trim() || input.parentNodeId === input.nodeId)) {
      return toolText({ error: "reparent-node requires a different parentNodeId on the current page." }, true);
    }
    if (input.operation === "set-current-page" && (typeof input.pageId !== "string" || !input.pageId.trim())) {
      return toolText({ error: "set-current-page requires pageId from the approved file." }, true);
    }
    if (input.operation === "group-nodes" && (!Array.isArray(input.nodeIds) || input.nodeIds.length < 2 || input.nodeIds.length > 100)) {
      return toolText({ error: "group-nodes requires at least two nodeIds." }, true);
    }
    if (input.operation === "apply-style" && (typeof input.styleKind !== "string" || !["paint", "text", "effect", "grid"].includes(input.styleKind) || (!(typeof input.styleId === "string" && input.styleId.trim()) && !(typeof input.styleName === "string" && input.styleName.trim())))) {
      return toolText({ error: "apply-style requires styleKind and either styleId or styleName." }, true);
    }
    if (input.operation === "reorder-node" && !Number.isInteger(input.index)) return toolText({ error: "reorder-node requires an integer index." }, true);
    if (input.operation === "set-selection" && !Array.isArray(input.nodeIds)) return toolText({ error: "set-selection requires nodeIds; pass [] to clear selection." }, true);
    if (input.operation === "zoom-to-nodes" && (!Array.isArray(input.nodeIds) || input.nodeIds.length < 1)) return toolText({ error: "zoom-to-nodes requires at least one nodeId." }, true);
    if ((input.operation === "create-page" || input.operation === "rename-page") && (typeof input.pageName !== "string" || !input.pageName.trim())) {
      return toolText({ error: input.operation + " requires pageName." }, true);
    }
    try {
      return toolText(await queueFigmaCanvasCommand(request, "write-canvas", payload));
    } catch (error) {
      return toolText({ status: "error", error: error instanceof Error ? error.message : "Could not queue Figma canvas action." }, true);
    }
  }

  if (name === "ux_direct_figma_canvas_command_status") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const commandId = typeof input.commandId === "string" ? input.commandId.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(commandId)) return toolText({ error: "Provide a valid commandId returned by a Figma canvas read/write tool." }, true);
    const snapshot = await fetchBridgeSnapshot(request);
    const session = (snapshot.sessions ?? []).find((item) => item.latestCommand?.commandId === commandId);
    const command = session?.latestCommand;
    if (!command) return toolText({ commandId, status: "not_found", message: "No matching active canvas command was found. It may have expired or been replaced by another plugin command." });
    return toolText({
      commandId, action: command.action ?? null, status: command.status ?? "unknown",
      issuedAt: command.issuedAt ?? null, completedAt: command.completedAt ?? null,
      failure: command.failure ?? null,
      result: command.status === "completed" ? command.result ?? null : null,
      pluginSession: { clientId: session?.clientId ?? null, isOnline: session?.isOnline === true, lastHeartbeatAt: session?.lastHeartbeatAt ?? null },
    });
  }

  if (name === "ux_direct_plan_task") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be a JSON object." }, true);
    const input = args as Record<string, unknown>;
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const taskRequest = typeof input.request === "string" ? input.request.trim() : "";
    const project = input.project;

    if (!title || title.length > 160 || taskRequest.length < 5 || taskRequest.length > 8000) {
      return toolText({ error: "Provide a title (1–160 characters) and request (5–8000 characters)." }, true);
    }
    if (project !== "general" && project !== "express-computers") {
      return toolText({ error: "Project must be 'general' or 'express-computers'." }, true);
    }

    const response = await fetch(new URL("/api/tasks/plan", request.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title, request: taskRequest, project }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({ error: "UX Direct task planner returned invalid JSON." }));
    return response.ok ? toolText(body) : toolText({ status: response.status, body }, true);
  }

  if (name === "ux_direct_brain_search") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const scopeKeys = Array.isArray(input.scopeKeys) ? input.scopeKeys.filter((item): item is string => typeof item === "string") : ["UX_SHARED_BRAIN"];
    const result = await retrieveBrainContext({
      query: typeof input.query === "string" ? input.query : "",
      scopeKeys,
      limit: typeof input.limit === "number" ? input.limit : 6,
      maxChars: typeof input.maxChars === "number" ? input.maxChars : 3200,
      includeKnowledge: input.includeKnowledge !== false,
    });
    return toolText({ ...result, scopeKeys, modelInferenceCalls: 0 });
  }

  if (name === "ux_direct_brain_save_feedback") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const result = await saveBrainFeedback({
      rawFeedback: String(input.rawFeedback || ""),
      summary: typeof input.summary === "string" ? input.summary : undefined,
      title: String(input.title || ""),
      normalizedRule: String(input.normalizedRule || ""),
      rationale: typeof input.rationale === "string" ? input.rationale : undefined,
      scopeKey: typeof input.scopeKey === "string" ? input.scopeKey : "UX_SHARED_BRAIN",
      feedbackKind: typeof input.feedbackKind === "string" ? input.feedbackKind : "general",
      keywords: Array.isArray(input.keywords) ? input.keywords.filter((v): v is string => typeof v === "string") : [],
      examples: Array.isArray(input.examples) ? input.examples : [],
      originalLanguage: typeof input.originalLanguage === "string" ? input.originalLanguage : "unknown",
      sourceProduct: String(input.sourceProduct || "chatgpt"),
      sourceAuditRef: typeof input.sourceAuditRef === "string" ? input.sourceAuditRef : undefined,
      sourceFindingTitle: typeof input.sourceFindingTitle === "string" ? input.sourceFindingTitle : undefined,
      idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
    });
    return toolText({ feedback: result, active: result.activated === true, activation: result.activated === true ? "automatic" : "not_reactivated", nextAction: result.activated === true ? "Eligible lesson is active for future scoped retrieval; no approval step is required." : "This matching item remains inactive because it was previously rejected or archived." });
  }

  if (name === "ux_direct_brain_list_feedback") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const feedback = await listBrainFeedback({
      status: typeof input.status === "string" ? input.status : "all",
      sourceProduct: typeof input.sourceProduct === "string" ? input.sourceProduct : undefined,
      limit: typeof input.limit === "number" ? input.limit : 30,
    });
    return toolText({ count: feedback.length, feedback });
  }

  if (name === "ux_direct_brain_review_feedback") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    if (!["approve","reject","archive"].includes(String(input.decision))) return toolText({ error: "decision must be approve, reject, or archive." }, true);
    const result = await reviewBrainFeedback({ feedbackId: String(input.feedbackId || ""), action: input.decision as "approve" | "reject" | "archive", reviewNote: typeof input.reviewNote === "string" ? input.reviewNote : undefined, expectedSourceProduct: typeof input.sourceProduct === "string" ? input.sourceProduct : undefined });
    return toolText(result);
  }

  if (name === "ux_direct_brain_add_reference") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const result = await addBrainKnowledgeDocument({
      title: String(input.title || ""),
      content: String(input.content || ""),
      projectKey: typeof input.projectKey === "string" ? input.projectKey : "UX_SHARED_BRAIN",
      sourceUrl: typeof input.sourceUrl === "string" ? input.sourceUrl : undefined,
      sourceType: typeof input.sourceType === "string" ? input.sourceType : "reference",
      sourceAuthority: typeof input.sourceAuthority === "string" ? input.sourceAuthority : "internal",
      sourceProduct: typeof input.sourceProduct === "string" ? input.sourceProduct : "knowledge-ingestion",
    });
    return toolText({ document: result, active: result.active === true, activation: "automatic", nextAction: result.active === true ? "Eligible reference is active for scoped retrieval; no approval step is required." : "Reference is not active. Inspect the result and ingestion error." });
  }

  if (name === "ux_direct_brain_list_references") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const documents = await listBrainKnowledgeDocuments({ status: typeof input.status === "string" ? input.status : "all", limit: typeof input.limit === "number" ? input.limit : 30 });
    return toolText({ count: documents.length, documents });
  }

  if (name === "ux_direct_brain_review_reference") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    if (!["approve","reject","archive"].includes(String(input.decision))) return toolText({ error: "decision must be approve, reject, or archive." }, true);
    return toolText(await reviewBrainKnowledgeDocument({ documentId: String(input.documentId || ""), action: input.decision as "approve" | "reject" | "archive" }));
  }

  if (name === "ux_direct_brain_add_eval_case") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const result = await saveBrainEvalCase({
      scopeKey: typeof input.scopeKey === "string" ? input.scopeKey : "UX_SHARED_BRAIN",
      capability: typeof input.capability === "string" ? input.capability : "retrieval",
      title: String(input.title || ""),
      input: String(input.input || ""),
      expectedBehavior: String(input.expectedBehavior || ""),
      forbiddenBehaviors: Array.isArray(input.forbiddenBehaviors) ? input.forbiddenBehaviors.filter((v): v is string => typeof v === "string") : [],
      expectedMemoryIds: Array.isArray(input.expectedMemoryIds) ? input.expectedMemoryIds.filter((v): v is string => typeof v === "string") : [],
    });
    return toolText({ evaluationCase: result, modelInferenceCalls: 0, nextAction: "Review and approve this case before it participates in retrieval regression tests." });
  }

  if (name === "ux_direct_brain_review_eval_case") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    if (!["approve","reject","archive"].includes(String(input.decision))) return toolText({ error: "decision must be approve, reject, or archive." }, true);
    return toolText(await reviewBrainEvalCase({ caseId: String(input.caseId || ""), action: input.decision as "approve" | "reject" | "archive" }));
  }

  if (name === "ux_direct_brain_run_retrieval_evals") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    return toolText({ ...(await runBrainRetrievalEvals(typeof input.limit === "number" ? input.limit : 50)), modelInferenceCalls: 0, paidModelCalls: 0 });
  }


  /* eslint-disable @typescript-eslint/no-explicit-any -- Normalize the UX Audit API payload contract at the MCP boundary. */







  /* eslint-enable @typescript-eslint/no-explicit-any */
  return toolText({ error: "Unknown UX Direct tool: " + name }, true);
}

export async function OPTIONS(request: Request) {
  if (!originIsAllowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(request) });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  // MCP clients use this unauthenticated challenge to discover OAuth metadata.
  return unauthorized(request);
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!originIsAllowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });

  const claims = authorizedClaims(request);
  if (!claims) return unauthorized(request);

  // Persist only a timestamp. Never store the bearer key or the user's prompt here.
  await recordChatGPTActivity().catch(() => {
    console.warn("[ux-direct-mcp] Could not persist ChatGPT connection activity.");
  });

  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415, headers });
  }

  let raw: string;
  try { raw = await request.text(); }
  catch { return NextResponse.json({ error: "Could not read request body." }, { status: 400, headers }); }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "MCP request body is too large." }, { status: 413, headers });
  }

  let message: JsonRpcMessage;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected one JSON-RPC object.");
    message = parsed as JsonRpcMessage;
  } catch {
    return rpcError(null, -32700, "Parse error.", headers);
  }

  const id = message.id === undefined ? null : message.id;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(id, -32600, "Invalid JSON-RPC request.", headers);
  }

  const protocolHeader = request.headers.get("mcp-protocol-version");
  if (protocolHeader && !PROTOCOL_VERSIONS.has(protocolHeader)) {
    return rpcError(id, -32600, "Unsupported MCP protocol version.", headers);
  }

  if (message.id === undefined) return new Response(null, { status: 202, headers });

  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Record<string, unknown> : {};

  try {
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ux-direct", version: "0.1.0" },
          instructions: "UX Direct is the conversational cockpit and native Figma executor inside the installed plugin. This MCP connection has full control: backend/connection status, plugin health checks, bounded Figma canvas reads, explicitly confirmed canvas writes, task planning, UX Audit workflows and owner-authorized shared-brain learning. Figma commands run through the approved file's native plugin APIs, so the plugin must be open and connected; Figma OAuth is not required. Read the canvas before writing, send writes only for an explicit user request with confirm=true, and verify every queued action from its command ID; current canvas evidence takes precedence over remembered rules. Keep client-specific past findings separate from generalized approved shared knowledge; preserve Hindi/Hinglish feedback. Audit workflows may incur OpenRouter costs.",
        }, headers);
      }
      case "ping":
        return rpcResult(id, {}, headers);
      case "tools/list":
        return rpcResult(id, { tools: TOOLS.filter((tool) => claimHasScope(claims, toolScope(tool.name))) }, headers);
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") return rpcError(id, -32602, "tools/call requires a tool name.", headers);
        if (!TOOLS.some(tool => tool.name === name)) return rpcResult(id, toolText({ error: "Unknown UX Direct tool: " + name }, true), headers);
        if (!claimHasScope(claims, toolScope(name))) {
          return rpcResult(id, toolText({ error: "OAuth token is missing required scope " + toolScope(name) + ". Reconnect UX Direct with full access." }, true), headers);
        }
        try {
          return rpcResult(id, await callTool(name, params.arguments ?? {}, request), headers);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "UX Direct tool call failed.";
          return rpcResult(id, toolText({ error: messageText.slice(0, 500) }, true), headers);
        }
      }
      default:
        return rpcError(id, -32601, "Method not found.", headers);
    }
  } catch {
    return rpcError(id, -32603, "Internal MCP error.", headers);
  }
}
