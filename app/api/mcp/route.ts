import { randomUUID, timingSafeEqual } from "node:crypto";
import { getMcpIssuer, verifyMcpPayload } from "@/lib/mcp-oauth";
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
    "ux_direct_uxaudit_run_page_audit",
    "ux_direct_uxaudit_generate_improved_ia",
    "ux_direct_uxaudit_run_benchmark",
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

/* eslint-disable @typescript-eslint/no-explicit-any -- UX Audit APIs return external JSON/SSE payloads normalized below. */
const DEFAULT_UX_AUDIT_ORIGIN = "https://uxaudit.zunaid-cb7.workers.dev";

function uxauditOrigin(): string {
  const configured = process.env.UX_AUDIT_BASE_URL?.trim() || DEFAULT_UX_AUDIT_ORIGIN;
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new Error("UX_AUDIT_BASE_URL must be a valid HTTPS URL."); }
  if (parsed.protocol !== "https:") throw new Error("UX Audit must be called over HTTPS.");
  return parsed.origin;
}

async function requestUxAudit(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  const endpoint = new URL(path.startsWith("/") ? path : "/" + path, uxauditOrigin());
  const method = options.method || (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(endpoint.toString(), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? 55_000),
  });
  const raw = await response.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object" && typeof parsed.error === "string"
      ? parsed.error
      : "UX Audit returned HTTP " + response.status + ".";
    throw new Error(String(detail).slice(0, 700));
  }
  return parsed;
}

function requirePublicAuditUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("url is required.");
  let target: URL;
  try { target = new URL(raw.trim()); } catch { throw new Error("url must be an absolute HTTP/HTTPS URL."); }
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Only public HTTP/HTTPS URLs are supported.");
  if (target.username || target.password) throw new Error("URLs containing credentials are not supported.");
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("Local/private hostnames cannot be audited.");
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|224\.|239\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    throw new Error("Private or loopback IP addresses cannot be audited.");
  }
  return target;
}

function parseUxAuditStream(raw: unknown): { page?: any; auditId?: string; error?: string } {
  if (typeof raw !== "string") return { error: "UX Audit returned a non-text audit stream." };
  let page: any;
  let auditId: string | undefined;
  let streamError = "";
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const line = frame.split(/\r?\n/).find((part) => part.startsWith("data: "));
    if (!line) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event?.type === "result") {
        const payload = event.payload || event.result || {};
        page = payload.page || payload.result?.pages?.[0] || payload.pages?.[0];
        auditId = typeof payload.auditId === "string" ? payload.auditId : undefined;
      }
      if (event?.type === "error") streamError = String(event.error || "AI audit failed.");
    } catch {}
  }
  return streamError ? { error: streamError } : { page, auditId };
}

function compactUxAuditPage(page: any) {
  if (!page || typeof page !== "object") return page;
  const { screenshot, ...metadata } = page;
  return {
    ...metadata,
    screenshotAvailable: typeof screenshot === "string" && screenshot.startsWith("data:image/"),
    findings: Array.isArray(page.findings) ? page.findings.map((finding: any) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      description: finding.description,
      recommendation: finding.recommendation,
      uxPerspective: finding.uxPerspective,
      businessAnalysis: finding.businessAnalysis,
      evidence: finding.evidence,
    })) : [],
  };
}

function warningsForUxAuditPages(pages: any[]) {
  const deep = pages.filter((page) => Number(page.depth) >= 3);
  const other = pages.filter((page) => page.category === "Other Pages");
  const about = pages.filter((page) => page.category === "About Us");
  return [
    ...(deep.length ? [{ id: "deep-page-hierarchy", title: "Deep page hierarchy", detail: deep.length + " URLs are three or more levels deep. Review whether priority journeys can be brought closer to the top level.", urls: deep.map((page) => page.url) }] : []),
    ...(about.length >= 4 ? [{ id: "about-us-sprawl", title: "About Us sprawl", detail: about.length + " About Us pages were discovered. Review overlap and grouping.", urls: about.map((page) => page.url) }] : []),
    ...(other.length ? [{ id: "unclear-page-grouping", title: "Unclear page grouping", detail: other.length + " pages could not be classified confidently from their URL or title.", urls: other.map((page) => page.url) }] : []),
  ];
}

async function runUxAuditPage(input: Record<string, unknown>) {
  const target = requirePublicAuditUrl(input.url);
  const mode = input.mode === "mobile" ? "mobile" : "desktop";
  const viewport = mode === "mobile" ? { width: 393, height: 852 } : { width: 1440, height: 900 };
  const projectName = typeof input.projectName === "string" && input.projectName.trim()
    ? input.projectName.trim().slice(0, 200)
    : target.hostname;
  let page: any;
  let auditId: string | undefined;
  const screenshotDataUrl = typeof input.screenshotDataUrl === "string" ? input.screenshotDataUrl.trim() : "";
  if (screenshotDataUrl) {
    if (screenshotDataUrl.length > 21 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(screenshotDataUrl)) {
      throw new Error("screenshotDataUrl must be a PNG/JPEG/WebP base64 data URL of at most 15 MB decoded size. Do not upload a CDN/403 error page as evidence.");
    }
    const pathname = target.pathname.split("/").filter(Boolean);
    const title = typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 160)
      : pathname.length ? pathname[pathname.length - 1].replace(/[-_]/g, " ") : "Homepage";
    const raw = await requestUxAudit("/api/audit-screenshot", {
      method: "POST",
      timeoutMs: 70_000,
      body: { url: target.href, projectName, title, screenshot: screenshotDataUrl, auditMode: mode, viewport },
    });
    const parsed = parseUxAuditStream(raw);
    if (parsed.error) throw new Error(parsed.error);
    page = parsed.page;
    auditId = parsed.auditId;
  } else {
    const result = await requestUxAudit("/api/audit-url", {
      method: "POST",
      timeoutMs: 70_000,
      body: {
        url: target.href,
        projectName,
        auditMode: mode,
        verifiedModels: [{ provider: "OpenRouter", model: "openrouter/auto", tier: "paid" }],
      },
    });
    page = result?.page;
    auditId = typeof result?.auditId === "string" ? result.auditId : undefined;
  }
  if (!page || !Array.isArray(page.findings)) throw new Error("UX Audit finished without a valid findings report.");
  const discovery = await requestUxAudit("/api/discover", {
    method: "POST",
    timeoutMs: 22_000,
    body: { url: target.origin },
  }).catch(() => ({ root: target.origin, title: target.hostname, pages: [{ url: target.origin, title: "Homepage", category: "Home", depth: 0 }] }));
  const pageList = Array.isArray(discovery.pages) && discovery.pages.length
    ? discovery.pages.slice(0, 120)
    : [{ url: target.origin, title: "Homepage", category: "Home", depth: 0 }];
  const sessionId = randomUUID();
  let sessionSaved = false;
  try {
    await requestUxAudit("/api/ia-session", {
      method: "POST",
      timeoutMs: 22_000,
      body: {
        id: sessionId,
        root: discovery.root || target.origin,
        title: discovery.title || target.hostname,
        discovery: { root: discovery.root || target.origin, title: discovery.title || target.hostname, pages: pageList, note: discovery.note || "Created by UX Direct MCP." },
        selected_urls: [target.href],
        audited_pages: [page],
        stage: "results",
        project_name: projectName,
      },
    });
    sessionSaved = true;
  } catch (error) {
    console.warn("[ux-direct-mcp] UX Audit session save failed.", error instanceof Error ? error.message.slice(0, 160) : "");
  }
  const findings = page.findings.map((finding: any) => ({
    id: finding.id, url: page.url || target.href, pageTitle: page.title || target.hostname,
    severity: finding.severity, category: finding.category, title: finding.title,
    description: finding.description, recommendation: finding.recommendation,
    uxPerspective: finding.uxPerspective, businessAnalysis: finding.businessAnalysis, evidence: finding.evidence,
  }));
  return {
    url: target.href, mode, viewport, projectName, title: page.title || target.hostname,
    auditId: auditId || null, sessionId: sessionSaved ? sessionId : null, sessionSaved,
    findingCount: findings.length, findings, report: compactUxAuditPage(page),
    nextSteps: sessionSaved ? ["Use ux_direct_uxaudit_generate_improved_ia with the sessionId.", "Retrieve approved learning through ux_direct_brain_search before deciding on recommendations."] : ["Audit completed but IA session saving failed; the findings are included in this response."],
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

const TOOLS = [
  {
    name: "ux_direct_status",
    description: "Check whether the UX Direct backend is healthy and inspect its non-secret service status. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_connection_status",
    description: "Show whether ChatGPT and the approved Figma plugin are connected, and queue a read-only selection snapshot of the currently selected Figma layers through the UX Direct plugin. Use ux_direct_figma_plugin_health_check_status with the returned commandId to retrieve the actual selection; no separate Figma connector is used. ChatGPT state means authenticated MCP activity within five minutes; Figma state means a heartbeat within 75 seconds.",
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
    description: "Retrieve status/results for a queued native Figma plugin API self-test, or the read-only selection command returned by ux_direct_connection_status. For selection reads, the response includes canvasResult when the command completes.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]{8,100}$", description: "The commandId returned by ux_direct_figma_plugin_queue_health_check or the selectionRead field of ux_direct_connection_status." },
      },
      required: ["commandId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_canvas_read",
    description: "Read the currently selected layers or a bounded tree of the active Figma page through the open UX Direct plugin. This queues a native Plugin API command; retrieve the result with ux_direct_figma_canvas_command_status. Reads are limited to the exact allowlisted Figma file and do not mutate the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["selection", "current-page"], description: "Read selected layers or the active page's layer tree." },
        maxDepth: { type: "integer", minimum: 0, maximum: 4, description: "Maximum descendant depth; defaults to 2." },
        maxNodes: { type: "integer", minimum: 1, maximum: 100, description: "Maximum total nodes returned; defaults to 60." },
        queryName: { type: "string", minLength: 1, maxLength: 120, description: "Optional case-insensitive node-name search across the current page." },
        queryType: { type: "string", minLength: 1, maxLength: 80, description: "Optional Figma node type filter, for example COMPONENT, INSTANCE, TEXT, or FRAME." },
        includePages: { type: "boolean", description: "Include page IDs and names." },
        includeStyles: { type: "boolean", description: "Include compact IDs/names for local paint, text, effect, and grid styles." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_figma_canvas_write",
    description: "Run explicit, validated native Figma canvas actions through the allowlisted UX Direct plugin. Supports ordered batches of up to 40 actions, frames/shapes/text/vectors, geometry/typography/fills/strokes/auto-layout/effects/image fills, grouping/flattening/boolean operations, component variants and swapping, local styles, selection/viewport control, cycle-safe reparenting within the active page, page creation/rename/switching, SVG/PNG/PDF export. Every write requires confirm=true and is audited; deletion is limited to a node on the current page. No arbitrary code execution, unrestricted document traversal, library publishing, or bulk replacement. Retrieve verified results with ux_direct_figma_canvas_command_status.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["batch", "create-elements", "update-node", "clone-node", "delete-node", "reorder-node", "reparent-node", "group-nodes", "flatten-nodes", "boolean-operation", "ungroup-node", "create-component", "create-component-set", "create-instance", "swap-component", "detach-instance", "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill"] },
        confirm: { type: "boolean", const: true, description: "Must be true only after the owner explicitly requests this specific write." },
        target: { type: "string", enum: ["current-page", "selection", "test-lab"] },
        elements: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "SLICE", "VECTOR"] },
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
              cornerRadius: { type: "number", minimum: 0, maximum: 512 },
              clipsContent: { type: "boolean" },
              layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL"] },
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
              operation: { type: "string", enum: ["create-elements", "update-node", "clone-node", "delete-node", "reorder-node", "reparent-node", "group-nodes", "flatten-nodes", "boolean-operation", "ungroup-node", "create-component", "create-component-set", "create-instance", "swap-component", "detach-instance", "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill"] },
              target: { type: "string", enum: ["current-page", "selection", "test-lab"] },
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
                  fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }
                },
                required: ["start", "end"],
                additionalProperties: false
              },
              imageBase64: { type: "string", maxLength: 250000 },
              scaleMode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"] },
              elements: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: true } },
              patch: { type: "object", additionalProperties: true }
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
            layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL"] },
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
            shadowSpread: { type: "number", minimum: -200, maximum: 200 }
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
            fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }
          },
          required: ["start", "end"],
          additionalProperties: false
        },
        imageBase64: { type: "string", maxLength: 250000 },
        scaleMode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"] }
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
    description: "Internal coaching tool. When the owner explains in Hindi/Hinglish/English what UX Direct, UX Audit, or the Figma plugin got wrong or should learn, interpret the feedback yourself and create a compact reusable rule; do not ask the owner to copy a special instruction. Preserve the original wording. Classify the lesson, rationale, scope, keywords, and optional example/audit reference. Save as draft by default. If the owner explicitly asks to train/remember/store it for future use, call the review tool after saving and approve it; do not approve a routine correction without that clear reuse intent. Keep client-specific findings out of global shared scope.",
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
    inputSchema: { type: "object", properties: { feedbackId: { type: "string", format: "uuid" }, decision: { type: "string", enum: ["approve","reject","archive"] }, reviewNote: { type: "string", maxLength: 1000 }, sourceProduct: { type: "string", enum: ["ux-direct","ux-audit","figma-plugin","chatgpt","local-model","benchmark","knowledge-ingestion"] } }, required: ["feedbackId","decision"], additionalProperties: false },
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
  {
    name: "ux_direct_uxaudit_status",
    description: "Check the UX Audit service and OpenRouter connectivity without running inference. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_uxaudit_discover_site",
    description: "Discover a public website's linked pages, sitemap URLs, labels, categories and URL depth before an IA review. No screenshot inference.",
    inputSchema: { type: "object", properties: { url: { type: "string", minLength: 8, maxLength: 1800, description: "Website root URL, for example https://www.ujjivansfb.bank.in/." } }, required: ["url"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "ux_direct_uxaudit_run_page_audit",
    description: "Run an evidence-led desktop or mobile UX audit through UX Audit, then save the result to Past Findings and a recent IA session. Desktop is 1440 px wide; mobile is 393×852 CSS px. May incur OpenRouter model costs. If automated capture is blocked, supply screenshotDataUrl from the actual page, never a CDN/403 error screenshot.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", minLength: 8, maxLength: 1800, description: "Exact page URL to audit." },
      mode: { type: "string", enum: ["desktop", "mobile"], description: "Desktop (1440 px wide) or mobile (393×852 CSS px)." },
      projectName: { type: "string", maxLength: 200, description: "Client or project label, e.g. Ujjivan Small Finance Bank." },
      title: { type: "string", maxLength: 160, description: "Optional title for a supplied screenshot." },
      screenshotDataUrl: { type: "string", maxLength: 22020096, description: "Optional PNG/JPEG/WebP base64 data URL of the actual website screenshot." },
    }, required: ["url"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ux_direct_uxaudit_get_session_report",
    description: "Retrieve a recent saved UX Audit IA session and its findings by UUID. Sessions usually expire after 30 minutes; the underlying audit remains in Past Findings.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string", format: "uuid" } }, required: ["sessionId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ux_direct_uxaudit_generate_improved_ia",
    description: "Create a reviewable, task-oriented improved information architecture from a saved discovery session and its findings. Does not change the live website.",
    inputSchema: { type: "object", properties: {
      sessionId: { type: "string", format: "uuid" },
      targetUrl: { type: "string", maxLength: 1800 },
      findingId: { type: "string", maxLength: 180 },
      issueTitle: { type: "string", maxLength: 180 },
    }, required: ["sessionId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ux_direct_uxaudit_run_benchmark",
    description: "Audit a client homepage and up to three competitor homepages in desktop or mobile mode, then return a comparable evidence-based snapshot. Runs at most two website audits concurrently; each successful audit is preserved in Past Findings. Finding counts are not a normalized quality score and model calls may incur cost.",
    inputSchema: { type: "object", properties: {
      clientName: { type: "string", minLength: 1, maxLength: 200 },
      clientUrl: { type: "string", minLength: 8, maxLength: 1800 },
      competitors: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        url: { type: "string", minLength: 8, maxLength: 1800 },
      }, required: ["name", "url"], additionalProperties: false } },
      mode: { type: "string", enum: ["desktop", "mobile"], description: "Run one comparable viewport per invocation. Call once for desktop and again for mobile when both are needed." },
    }, required: ["clientName", "clientUrl", "competitors"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    let selectionRead: Record<string, unknown>;
    try {
      selectionRead = await queueFigmaCanvasCommand(request, "read-canvas", {
        scope: "selection", maxDepth: 2, maxNodes: 60,
      });
    } catch (error) {
      selectionRead = {
        status: "unavailable",
        error: error instanceof Error ? error.message.slice(0, 500) : "Could not queue a selection read through UX Direct.",
      };
    }
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
        selectionRead,
        selectionNote: "Selection is read through the native UX Direct plugin command bridge. If selectionRead.status is queued, use ux_direct_figma_plugin_health_check_status with its commandId to retrieve the selected layers.",
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
    if (scope !== "selection" && scope !== "current-page") return toolText({ error: "scope must be selection or current-page." }, true);
    if (!Number.isInteger(maxDepth) || (maxDepth as number) < 0 || (maxDepth as number) > 4) return toolText({ error: "maxDepth must be an integer from 0 to 4." }, true);
    if (!Number.isInteger(maxNodes) || (maxNodes as number) < 1 || (maxNodes as number) > 100) return toolText({ error: "maxNodes must be an integer from 1 to 100." }, true);
    if (queryName !== undefined && (typeof queryName !== "string" || !queryName.trim() || queryName.length > 120)) return toolText({ error: "queryName must be a non-empty string up to 120 characters." }, true);
    if (queryType !== undefined && (typeof queryType !== "string" || !queryType.trim() || queryType.length > 80)) return toolText({ error: "queryType must be a non-empty string up to 80 characters." }, true);
    if (input.includePages !== undefined && typeof input.includePages !== "boolean") return toolText({ error: "includePages must be boolean." }, true);
    if (input.includeStyles !== undefined && typeof input.includeStyles !== "boolean") return toolText({ error: "includeStyles must be boolean." }, true);
    try {
      return toolText(await queueFigmaCanvasCommand(request, "read-canvas", {
        scope, maxDepth, maxNodes,
        ...(queryName === undefined ? {} : { queryName }),
        ...(queryType === undefined ? {} : { queryType }),
        includePages, includeStyles,
      }));
    } catch (error) {
      return toolText({ status: "error", error: error instanceof Error ? error.message : "Could not queue Figma canvas read." }, true);
    }
  }

  if (name === "ux_direct_figma_canvas_write") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const allowedOperations = new Set([
      "batch", "create-elements", "update-node", "clone-node", "delete-node", "reorder-node", "reparent-node",
      "group-nodes", "flatten-nodes", "boolean-operation", "ungroup-node", "create-component", "create-component-set", "create-instance", "swap-component",
      "detach-instance", "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill",
    ]);
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
      ...(input.range === undefined ? {} : { range: input.range }),
      ...(input.imageBase64 === undefined ? {} : { imageBase64: input.imageBase64 }),
      ...(input.scaleMode === undefined ? {} : { scaleMode: input.scaleMode }),
      ...(input.patch === undefined ? {} : { patch: input.patch }),
      ...(input.actions === undefined ? {} : { actions: input.actions }),
    };
    if (input.target !== undefined && !["current-page", "selection", "test-lab"].includes(String(input.target))) {
      return toolText({ error: "target must be current-page, selection, or test-lab." }, true);
    }
    if (input.operation === "batch" && (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 40)) return toolText({ error: "batch requires 1–40 actions." }, true);
    if (input.operation === "batch" && Array.isArray(input.actions) && input.actions.some((step) => step && typeof step === "object" && ["export-svg", "export-node", "create-image-fill"].includes(String((step as Record<string, unknown>).operation))) && input.actions.length > 1) return toolText({ error: "Exports and inline image fills must be standalone commands." }, true);
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
      const allowedTypes = new Set(["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "SLICE", "VECTOR"]);
      for (const item of input.elements) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return toolText({ error: "Each element must be an object." }, true);
        const element = item as Record<string, unknown>;
        if (!allowedTypes.has(String(element.type)) || typeof element.name !== "string" || !element.name.trim()) {
          return toolText({ error: "Each element requires a supported type and non-empty name." }, true);
        }
        if (element.type === "TEXT" && typeof element.text !== "string") return toolText({ error: "TEXT elements require text content." }, true);
        if (element.type === "VECTOR" && (!Array.isArray(element.vectorPaths) || element.vectorPaths.length < 1)) return toolText({ error: "VECTOR elements require vectorPaths." }, true);
      }
    }
    if (input.operation === "update-node") {
      if (typeof input.nodeId !== "string" || !input.nodeId.trim()) return toolText({ error: "update-node requires nodeId." }, true);
      if (!input.patch || typeof input.patch !== "object" || Array.isArray(input.patch) || !Object.keys(input.patch as Record<string, unknown>).length) {
        return toolText({ error: "update-node requires a non-empty patch." }, true);
      }
    }
    const nodeRequired = new Set(["clone-node", "delete-node", "reorder-node", "reparent-node", "ungroup-node", "create-component", "create-instance", "swap-component", "detach-instance", "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill"]);
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


  /* eslint-disable @typescript-eslint/no-explicit-any -- Normalize the UX Audit API payload contract at the MCP boundary. */
  if (name === "ux_direct_uxaudit_status") {
    const result = await requestUxAudit("/api/openrouter-status", { method: "GET", timeoutMs: 12_000 });
    return toolText({ service: "UX Audit", checkedAt: new Date().toISOString(), openRouter: result, baseUrl: uxauditOrigin() });
  }

  if (name === "ux_direct_uxaudit_discover_site") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const target = requirePublicAuditUrl(input.url);
    const result = await requestUxAudit("/api/discover", { method: "POST", timeoutMs: 22_000, body: { url: target.href } });
    return toolText({ ...result, source: "UX Audit via UX Direct MCP", modelInferenceCalls: 0 });
  }

  if (name === "ux_direct_uxaudit_run_page_audit") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    return toolText(await runUxAuditPage(args as Record<string, unknown>));
  }

  if (name === "ux_direct_uxaudit_get_session_report") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return toolText({ error: "Provide a valid session UUID." }, true);
    const result = await requestUxAudit("/api/ia-session?id=" + encodeURIComponent(sessionId), { method: "GET", timeoutMs: 20_000 });
    if (!result?.session) return toolText({ error: "UX Audit session was not found or has expired." }, true);
    const session = result.session;
    const reports = Array.isArray(session.audited_pages) ? session.audited_pages : [];
    return toolText({
      sessionId: session.id, root: session.root, title: session.title, stage: session.stage,
      projectName: session.project_name, discovery: session.discovery,
      auditedPages: reports.map((page: any) => compactUxAuditPage(page)),
      selectedUrls: session.selected_urls || [],
    });
  }

  if (name === "ux_direct_uxaudit_generate_improved_ia") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return toolText({ error: "Provide a valid session UUID." }, true);
    const loaded = await requestUxAudit("/api/ia-session?id=" + encodeURIComponent(sessionId), { method: "GET", timeoutMs: 20_000 });
    const session = loaded?.session;
    if (!session?.discovery || !Array.isArray(session.discovery.pages) || !session.discovery.pages.length) return toolText({ error: "The saved session has no discovered pages. Run IA discovery or a page audit first." }, true);
    const pages = session.discovery.pages.slice(0, 120);
    const findings = (Array.isArray(session.audited_pages) ? session.audited_pages : []).flatMap((report: any) =>
      (Array.isArray(report.findings) ? report.findings : []).map((finding: any) => ({
        id: String(report.url || "") + "::" + String(finding.id || finding.title || "finding"),
        sourceId: String(finding.id || ""), url: String(report.url || ""), title: String(finding.title || "UX finding"),
        category: String(finding.category || "Visual design"), severity: String(finding.severity || "medium"),
        description: String(finding.description || ""), recommendation: String(finding.recommendation || ""),
      })),
    ).slice(0, 100);
    const payload = {
      root: session.root || session.discovery.root,
      websiteTitle: session.discovery.title || session.title || session.root,
      projectName: session.project_name || "Website",
      pages: pages.map((page: any) => ({ url: page.url, title: page.title, category: page.category, depth: Number(page.depth || 0) })),
      findings,
      iaWarnings: warningsForUxAuditPages(pages),
      targetUrl: typeof input.targetUrl === "string" ? input.targetUrl : "",
      focusFindingId: typeof input.findingId === "string" ? input.findingId : "",
      focusIssueTitle: typeof input.issueTitle === "string" ? input.issueTitle : "",
    };
    const result = await requestUxAudit("/api/generate-improved-ia", { method: "POST", timeoutMs: 65_000, body: payload });
    if (!result?.proposal) return toolText({ error: "The IA generator returned no proposal.", result }, true);
    return toolText({ sessionId, proposal: result.proposal, changesLiveWebsite: false });
  }

  if (name === "ux_direct_uxaudit_run_benchmark") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolText({ error: "Tool arguments must be an object." }, true);
    const input = args as Record<string, unknown>;
    const clientName = typeof input.clientName === "string" ? input.clientName.trim().slice(0, 200) : "";
    if (!clientName) return toolText({ error: "clientName is required." }, true);
    const clientUrl = requirePublicAuditUrl(input.clientUrl);
    const competitorInput = Array.isArray(input.competitors) ? input.competitors.slice(0, 3) : [];
    if (!competitorInput.length) return toolText({ error: "At least one competitor is required." }, true);
    const competitors = competitorInput.map((raw: any, index: number) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each competitor needs a name and URL.");
      const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 200) : "";
      if (!name) throw new Error("Competitor " + (index + 1) + " needs a name.");
      return { name, url: requirePublicAuditUrl(raw.url) };
    });
    const mode = input.mode === "mobile" ? "mobile" : "desktop";
    const entries = [{ name: clientName, url: clientUrl }, ...competitors.map((competitor: any) => ({ name: competitor.name, url: competitor.url }))];
    const canonical = entries.map((entry) => entry.url.origin.toLowerCase());
    if (new Set(canonical).size !== canonical.length) return toolText({ error: "Use a unique homepage URL for each institution." }, true);
    const output: any[] = new Array(entries.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(2, entries.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= entries.length) return;
        const entry = entries[index];
        try {
          const result = await requestUxAudit("/api/audit-url", {
            method: "POST",
            timeoutMs: 70_000,
            body: {
              url: entry.url.origin + "/",
              projectName: entry.name,
              auditMode: mode,
              verifiedModels: [{ provider: "OpenRouter", model: "openrouter/auto", tier: "paid" }],
            },
          });
          const page = result?.page;
          if (!page || !Array.isArray(page.findings)) throw new Error("Audit completed without a findings report.");
          const findings = page.findings.map((finding: any) => ({
            severity: finding.severity, category: finding.category, title: finding.title,
            description: finding.description, recommendation: finding.recommendation,
            uxPerspective: finding.uxPerspective, businessAnalysis: finding.businessAnalysis, evidence: finding.evidence,
          }));
          output[index] = {
            name: entry.name, url: entry.url.origin + "/", mode,
            viewport: mode === "mobile" ? { width: 393, height: 852 } : { width: 1440, height: 900 },
            auditId: typeof result.auditId === "string" ? result.auditId : null,
            findingCount: findings.length,
            severityCounts: {
              high: findings.filter((finding: any) => String(finding.severity).toLowerCase() === "high").length,
              medium: findings.filter((finding: any) => String(finding.severity).toLowerCase() === "medium").length,
              low: findings.filter((finding: any) => String(finding.severity).toLowerCase() === "low").length,
            },
            categories: [...new Set(findings.map((finding: any) => finding.category))],
            findings,
          };
        } catch (error) {
          output[index] = {
            name: entry.name, url: entry.url.origin + "/", mode,
            error: error instanceof Error ? error.message.slice(0, 600) : "Website audit failed.",
          };
        }
      }
    }));
    return toolText({
      mode,
      client: clientName,
      sitesProcessed: output.filter(Boolean).length,
      successfulSites: output.filter((item) => item && !item.error).length,
      reports: output,
      interpretation: "Compare like-for-like findings and evidence, not raw counts alone. Site complexity, capture quality and page content can affect findings. Run this tool once in desktop mode and again in mobile mode to compare both experiences. Every successful audit is preserved in Past Findings.",
    });
  }


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
          instructions: "UX Direct is the single brain and MCP control center. It provides shared-brain search/training plus UX Audit operations for public-site IA discovery, desktop/mobile screenshot auditing, report retrieval, improved IA proposals, and multi-site benchmarking. Use UX Direct shared-brain retrieval before analysis; UX Audit persists client-specific findings in Past Findings and retrieves relevant approved shared rules. Never promote client-specific raw findings into global memory; only validated generalizable lessons belong in the shared brain. Preserve Hindi/Hinglish feedback, save reusable lessons as drafts by default, and approve only when the owner explicitly asks to train or activate the rule. Audit work may incur OpenRouter costs. Figma plugin connectivity uses the installed plugin's native Figma Plugin APIs; Figma OAuth is not required for that path. Figma MCP actions use the installed UX Direct plugin native API and a bounded, authenticated command bridge. Reads can inspect selected/current-page nodes, filter by name/type, return page/style metadata and viewport geometry. Explicitly confirmed write actions cover frame/shape/text/vector creation; node property, text-range, fill/stroke/effect and auto-layout edits; clone/delete/reorder/group/ungroup/flatten/boolean operations; component creation, variants, instances, swap/detach; selection and viewport; page create/rename; local-style application; image fills; PNG/PDF/SVG exports; and sequential batches with explicit partial-failure reporting. Every node mutation is restricted to the allowlisted file and current-page nodes, with bounded payload/result sizes. There is no arbitrary code execution, broad replacement, or Team Library publishing. Check command status to verify every action. Use target=test-lab for safe write smoke tests. Current screenshot evidence takes precedence over remembered rules.",
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
