import { timingSafeEqual } from "node:crypto";
import { getChatGPTConnectionStatus, getFigmaPluginConnectionStatus, recordChatGPTActivity } from "@/src/connections/connection-status";
import { NextResponse } from "next/server";
import { addBrainKnowledgeDocument, listBrainFeedback, listBrainKnowledgeDocuments, reviewBrainEvalCase, reviewBrainFeedback, reviewBrainKnowledgeDocument, retrieveBrainContext, runBrainRetrievalEvals, saveBrainEvalCase, saveBrainFeedback } from "@/src/memory/shared-brain";

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
    description: "Internal coaching tool. When the owner explains in Hindi/Hinglish/English what UX Direct, UX Audit, or the Figma plugin got wrong or should learn, interpret the feedback yourself and create a compact reusable rule; do not ask the owner to copy a special instruction. Preserve the original wording. Classify the lesson, rationale, scope, keywords, and optional example/audit reference. Saves as draft only; never activate automatically. Keep client-specific findings out of global shared scope.",
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
    description: "Approve a saved coaching lesson into canonical shared memory, reject it, or archive it. Approve only after the owner explicitly confirms the lesson should become active. Archive a wrong/outdated rule instead of silently replacing it. Approval activates the short normalized rule for future retrieval; it does not fine-tune model weights.",
    inputSchema: { type: "object", properties: { feedbackId: { type: "string", format: "uuid" }, decision: { type: "string", enum: ["approve","reject","archive"] }, reviewNote: { type: "string", maxLength: 1000 } }, required: ["feedbackId","decision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_add_reference",
    description: "Add reusable product-agnostic UX, design-system, accessibility, interaction, cost, or Indian BFSI reference material to the shared brain. Save as a draft for human review. Do not bulk-import client past findings or confidential client artefacts as shared reference material.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 240 }, content: { type: "string", minLength: 1, maxLength: 100000 }, projectKey: { type: "string", enum: ["UX_SHARED_BRAIN","indian-bfsi","project:ux-direct","project:ux-audit","project:general-ux","project:dmi-finance","project:ujjivan-sfb","project:express-computers"] }, sourceUrl: { type: "string", format: "uri", maxLength: 1800 }, sourceType: { type: "string", maxLength: 60 }, sourceAuthority: { type: "string", maxLength: 60 }, sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"] } }, required: ["title","content"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_list_references",
    description: "List ingested reference documents and their draft/approved status in the shared product brain.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["all","draft","approved","rejected","archived","failed"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ux_direct_brain_review_reference",
    description: "Approve a reference document so its chunks can be retrieved, reject it, or archive it. Only approved documents are included in future model context.",
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
    return toolText({ feedback: result, active: false, nextAction: "Wait for explicit approval before calling ux_direct_brain_review_feedback with decision approve." });
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
    const result = await reviewBrainFeedback({ feedbackId: String(input.feedbackId || ""), action: input.decision as "approve" | "reject" | "archive", reviewNote: typeof input.reviewNote === "string" ? input.reviewNote : undefined });
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
    return toolText({ document: result, active: false, nextAction: "Review and approve the reference before any product can retrieve it." });
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
          instructions: "UX Direct offers health checks, connection status, reviewable UX task planning, and a controlled native Figma plugin API self-test. The self-test targets the dedicated UXD API Test Lab page in the pre-allowlisted file; it does not generate production designs. Use 'general' for BFSI website revamp work and 'express-computers' for Express Computers work. DMI-specific project data is not exposed through this connector.",
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
