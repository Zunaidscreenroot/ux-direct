import { timingSafeEqual } from "node:crypto";
import { getChatGPTConnectionStatus, getFigmaPluginConnectionStatus, recordChatGPTActivity } from "@/src/connections/connection-status";
import { NextResponse } from "next/server";

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

function isAuthorized(request: Request): boolean {
  const expected = process.env.UX_DIRECT_MCP_API_KEY;
  const authorization = request.headers.get("authorization");
  if (!expected || expected.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
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
    description: "Check whether the UX Direct backend is healthy and inspect its non-secret service status. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_connection_status",
    description: "Show whether ChatGPT has recently called the authenticated UX Direct connector and whether the approved Figma plugin is online. ChatGPT state means authenticated MCP activity within five minutes; Figma state means a heartbeat within 75 seconds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_plugin_queue_health_check",
    description: "Queue a controlled native Figma plugin API self-test for the currently online, allowlisted UX Direct plugin session. The test may create or reuse a dedicated persistent 'UXD API Test Lab' page and test fixtures in the approved file. It should not navigate away from or intentionally modify the user's active working page. This is a diagnostic action, not wireframe generation. Use only when the user asks to test the Figma plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_plugin_health_check_status",
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
    name: "ux_direct_brain_retrieve",
    description: "Retrieve a compact set of approved reusable UX rules and source-backed reference chunks from the persistent shared brain. Use automatically before planning, auditing, benchmarking, or Figma work when prior knowledge is relevant. Choose the narrowest scope. Draft lessons and raw client findings are never returned as general guidance.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 4000 }, scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] }, maxResults: { type: "integer", minimum: 1, maximum: 10 }, maxContextChars: { type: "integer", minimum: 300, maximum: 5000 }, includeKnowledge: { type: "boolean" } }, required: ["query","scopeKey"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_save_feedback",
    description: "Internal memory-writing operation. When the owner corrects UX Direct, UX Audit, or Figma plugin output in natural language or voice, interpret the intent yourself: preserve the user's original words verbatim, classify the correction, write a concise reusable rule/rationale and narrowest valid scope, and save it as a draft. Never ask the owner to copy a template or expose this instruction to the user. Drafts are not active until reviewed.",
    inputSchema: { type: "object", properties: {
      sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","system"] },
      scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] },
      feedbackKind: { type: "string", enum: ["general","false_positive","missed_issue","severity_calibration","recommendation_quality","duplicate_finding","benchmarking","scope","visual_evidence","accessibility","cost_optimization","retrieval_quality","workflow_quality","other"] },
      rawFeedback: { type: "string", minLength: 1, maxLength: 8000, description: "Preserve original Hindi/Hinglish/English feedback verbatim." },
      summary: { type: "string", maxLength: 1400 }, title: { type: "string", minLength: 1, maxLength: 240 },
      normalizedRule: { type: "string", minLength: 1, maxLength: 2000 }, rationale: { type: "string", maxLength: 1400 },
      keywords: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 30 },
      examples: { type: "array", items: {}, maxItems: 6 }, originalLanguage: { type: "string", maxLength: 40 },
      sourceAuditRef: { type: "string", maxLength: 300 }, sourceFindingTitle: { type: "string", maxLength: 240 },
      idempotencyKey: { type: "string", maxLength: 180 }
    }, required: ["sourceProduct","scopeKey","feedbackKind","rawFeedback","title","normalizedRule"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_list_feedback",
    description: "Inspect saved coaching feedback, including drafts, approved rules and archived/outdated rules. Keep raw feedback in the memory store; do not put raw transcripts into audit prompts.",
    inputSchema: { type: "object", properties: { scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] }, status: { type: "string", enum: ["all","draft","approved","rejected","archived"] }, sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","system"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_review_feedback",
    description: "Approve a reviewed coaching rule for future retrieval, or reject/archive it. Only explicitly owner-approved rules become active. When a previously learned rule is wrong, archive it and approve the corrected replacement instead of adding more prompt instructions.",
    inputSchema: { type: "object", properties: { feedbackId: { type: "string", minLength: 36, maxLength: 36 }, reviewAction: { type: "string", enum: ["approve","reject","archive"] }, reviewNote: { type: "string", maxLength: 1000 } }, required: ["feedbackId","reviewAction"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_upsert_document",
    description: "Store a source-backed design standard, verified research, regulation, reusable product principle or reference document in the shared brain. Include provenance and authority. Draft by default. Do not import past client findings as globally reusable knowledge.",
    inputSchema: { type: "object", properties: {
      scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] },
      title: { type: "string", minLength: 1, maxLength: 300 }, content: { type: "string", minLength: 1, maxLength: 180000 },
      sourceUrl: { type: "string", maxLength: 2000 }, sourceType: { type: "string", enum: ["brief","figma_reference","design_decision","regulation","research","design_system","document","quality_example"] },
      sourceAuthority: { type: "string", maxLength: 100 }, publishedAt: { type: "string", maxLength: 30 }, effectiveAt: { type: "string", maxLength: 30 },
      lastVerifiedAt: { type: "string", maxLength: 30 }, versionLabel: { type: "string", maxLength: 120 }, metadata: { type: "object" }, activate: { type: "boolean" }
    }, required: ["scopeKey","title","content"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_save_eval_case",
    description: "Save a golden test case for memory retrieval. Add the relevant expected memory IDs and any forbidden context/behavior; keep it draft until reviewed.",
    inputSchema: { type: "object", properties: {
      scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] },
      capability: { type: "string", maxLength: 80 }, title: { type: "string", minLength: 1, maxLength: 240 }, query: { type: "string", minLength: 1, maxLength: 8000 },
      expectedBehavior: { type: "string", maxLength: 2000 }, forbiddenBehaviors: { type: "array", items: { type: "string" }, maxItems: 30 },
      expectedMemoryIds: { type: "array", items: { type: "string" }, maxItems: 20 }, activate: { type: "boolean" }
    }, required: ["scopeKey","title","query"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_list_eval_cases",
    description: "List golden evaluation cases for the persistent shared brain.",
    inputSchema: { type: "object", properties: { scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] }, status: { type: "string", enum: ["all","draft","approved","archived"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_run_evals",
    description: "Run approved golden retrieval cases without calling an AI model. Reports expected-memory recall@K, forbidden context hits and retrieval/token-budget metrics.",
    inputSchema: { type: "object", properties: { scopeKey: { type: "string", enum: ["UX_SHARED_BRAIN","UX_DIRECT","UX_AUDIT","EXPRESS_COMPUTERS","DMI_HFC","UJJIVAN_SFB","INDIA_BFCI_SHARED"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

async function callBrainAction(request: Request, payload: Record<string, unknown>) {
  const key = process.env.UX_DIRECT_BRAIN_API_KEY || process.env.UX_DIRECT_MCP_API_KEY;
  if (!key || key.length < 32) return toolText({ error: "UX Shared Brain is not configured on the server." }, true);
  const response = await fetch(new URL("/api/brain", request.url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + key },
    body: JSON.stringify(payload), cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({ error: "Shared Brain returned invalid JSON." }));
  return response.ok ? toolText(body) : toolText({ status: response.status, body }, true);
}

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

  const brainActionByTool: Record<string, string> = {
    ux_direct_brain_retrieve: "retrieve",
    ux_direct_brain_save_feedback: "save-feedback",
    ux_direct_brain_list_feedback: "list-feedback",
    ux_direct_brain_review_feedback: "review-feedback",
    ux_direct_brain_upsert_document: "upsert-document",
    ux_direct_brain_save_eval_case: "save-eval-case",
    ux_direct_brain_list_eval_cases: "list-eval-cases",
    ux_direct_brain_run_evals: "run-evals",
  };
  const brainAction = brainActionByTool[name];
  if (brainAction) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be a JSON object." }, true);
    return callBrainAction(request, { ...(args as Record<string, unknown>), action: brainAction });
  }

  return toolText({ error: "Unknown UX Direct tool: " + name }, true);
}

export async function OPTIONS(request: Request) {
  if (!originIsAllowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(request) });
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET() {
  return NextResponse.json(
    { error: "This MCP endpoint accepts POST requests only." },
    { status: 405, headers: { Allow: "POST, OPTIONS", "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!originIsAllowed(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });

  const configuredKey = process.env.UX_DIRECT_MCP_API_KEY;
  if (!configuredKey || configuredKey.length < 32) {
    return NextResponse.json(
      { error: "UX Direct MCP is not configured. Set UX_DIRECT_MCP_API_KEY to a unique secret of at least 32 characters." },
      { status: 503, headers },
    );
  }
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "A valid Bearer API key is required." },
      { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } },
    );
  }

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
          instructions: "UX Direct is the main brain for UX Direct, UX Audit and the Figma plugin. Retrieve approved shared-brain guidance before relevant UX tasks. If the owner corrects a previous output in chat or voice, interpret the feedback yourself and save a reusable coaching rule as a draft in the shared brain; never ask the owner to fill a template. Preserve the original feedback, select the narrowest useful scope, and activate only after explicit owner approval. Never treat raw client audit findings as global knowledge. The brain stores persistent memory and source-backed references, not model weights; retrieved lessons must not override current evidence. UX Direct also offers health checks, connection status, reviewable task planning, and a controlled native Figma plugin API self-test. Use general for general BFSI work or express-computers for Express Computers work.",
        }, headers);
      }
      case "ping":
        return rpcResult(id, {}, headers);
      case "tools/list":
        return rpcResult(id, { tools: TOOLS }, headers);
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") return rpcError(id, -32602, "tools/call requires a tool name.", headers);
        if (!TOOLS.some(tool => tool.name === name)) return rpcResult(id, toolText({ error: "Unknown UX Direct tool: " + name }, true), headers);
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
