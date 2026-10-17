import { getChatGPTConnectionStatus, getFigmaPluginConnectionStatus, recordChatGPTActivity } from "@/src/connections/connection-status";
import { getMcpIssuer, verifyMcpPayload } from "@/lib/mcp-oauth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128_000;
const REQUEST_TIMEOUT_MS = 55_000;
const CHATGPT_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type AuthClaims = { typ: "access"; iss?: string; aud?: string; resource?: string; scope?: string; exp?: number; sub?: string };
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

function getBearer(request: Request): string {
  const header = request.headers.get("authorization") || "";
  return /^Bearer\\s+/i.test(header) ? header.replace(/^Bearer\\s+/i, "").trim() : "";
}

function tokenHasScope(token: AuthClaims, required: string): boolean {
  return String(token.scope || "").split(/\\s+/).includes(required);
}

function unauthorized(request: Request) {
  const metadata = getMcpIssuer(request) + "/.well-known/oauth-protected-resource/api/mcp";
  return NextResponse.json(
    { error: "unauthorized", error_description: "A valid UX Direct MCP OAuth token is required." },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer resource_metadata="' + metadata + '", scope="ux:read ux:plan figma:health"',
        "Cache-Control": "no-store",
      },
    },
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
    headers: { "content-type": "application/json", accept: "application/json", origin },
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

const TOOLS = [
  {
    name: "ux_direct_status",
    requiredScope: "ux:read",
    description: "Check whether the UX Direct backend is healthy and inspect its non-secret service status. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_connection_status",
    requiredScope: "ux:read",
    description: "Show whether ChatGPT has recently called the authenticated UX Direct connector and whether the approved Figma plugin is online. ChatGPT state means authenticated MCP activity within five minutes; Figma state means a heartbeat within 75 seconds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_plugin_queue_health_check",
    requiredScope: "figma:health",
    description: "Queue a controlled native Figma plugin API self-test for the currently online, allowlisted UX Direct plugin session. The test may create or reuse a dedicated persistent 'UXD API Test Lab' page and test fixtures in the approved file. It should not navigate away from or intentionally modify the user's active working page. This is a diagnostic action, not wireframe generation. Use only when the user asks to test the Figma plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_plugin_health_check_status",
    requiredScope: "ux:read",
    description: "Retrieve the status and results of a previously queued native Figma plugin API self-test by command ID. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]{8,100}$", description: "The commandId returned by ux_direct_figma_plugin_queue_health_check." },
      },
      required: ["commandId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_plan_task",
    requiredScope: "ux:plan",
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
        note: "Connected means the server received authenticated ChatGPT MCP activity in the last five minutes.",
      },
      figmaPlugin: {
        state: figmaPlugin.state,
        connected: figmaPlugin.connected,
        connectedSessions: figmaPlugin.connectedSessions,
        lastHeartbeatAt: figmaPlugin.lastHeartbeatAt,
        note: "Connected means at least one allowlisted Figma plugin session sent a heartbeat in the last 75 seconds.",
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
      status: session?.latestCommand?.status ?? (latestReport ? "completed" : "unknown"),
      issuedAt: session?.latestCommand?.issuedAt ?? null,
      completedAt: session?.latestCommand?.completedAt ?? latestReport?.savedAt ?? null,
      failure: session?.latestCommand?.failure ?? null,
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

  return toolText({ error: "Unknown UX Direct tool: " + name }, true);
}

export async function OPTIONS(request: Request) {
  if (!originIsAllowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(request) });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  // A 401 challenge advertises OAuth discovery to clients probing with GET.
  return unauthorized(request);
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!originIsAllowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });

  let issuer: string;
  let token: AuthClaims | null;
  try {
    issuer = getMcpIssuer(request);
    token = verifyMcpPayload(getBearer(request), "access") as AuthClaims | null;
  } catch {
    return NextResponse.json(
      { error: "UX Direct MCP OAuth is not configured. Set UX_DIRECT_MCP_OAUTH_SECRET and UX_DIRECT_MCP_CONNECTION_CODE for this deployment context." },
      { status: 503, headers },
    );
  }
  if (
    !token ||
    token.iss !== issuer ||
    token.aud !== issuer + "/api/mcp" ||
    token.resource !== issuer + "/api/mcp"
  ) return unauthorized(request);

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
          instructions: "UX Direct offers health checks, connection status, reviewable UX task planning, and a controlled native Figma plugin API self-test. The self-test targets the dedicated UXD API Test Lab page in the pre-allowlisted file; it does not generate production designs. Use 'general' for BFSI website revamp work and 'express-computers' for Express Computers work. DMI-specific project data is not exposed through this connector.",
        }, headers);
      }
      case "ping":
        return rpcResult(id, {}, headers);
      case "tools/list": {
        const visible = TOOLS.filter(tool => tokenHasScope(token!, tool.requiredScope));
        return rpcResult(id, { tools: visible.map(({ requiredScope, ...definition }) => definition) }, headers);
      }
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") return rpcError(id, -32602, "tools/call requires a tool name.", headers);
        const tool = TOOLS.find(candidate => candidate.name === name);
        if (!tool) return rpcResult(id, toolText({ error: "Unknown UX Direct tool: " + name }, true), headers);
        if (!tokenHasScope(token!, tool.requiredScope)) {
          return rpcResult(id, toolText({ error: "OAuth token is missing required scope " + tool.requiredScope + ". Reconnect with the required UX Direct permissions." }, true), headers);
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
