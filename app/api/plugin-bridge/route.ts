import { getStore } from "@netlify/blobs";
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
  checks: z.array(CHECK).max(100),
});
type HealthReport = z.infer<typeof REPORT>;
type BridgeCommand = {
  commandId: string; action: "native-api-health-check"; status: "pending" | "claimed" | "completed" | "failed";
  issuedAt: string; expiresAt: string; completedAt?: string; failure?: string;
};
type Session = {
  clientId: string; sessionToken: string; fileKey: string; status: "online" | "offline";
  connectedAt: string; lastHeartbeatAt: string; disconnectedAt?: string; lastTestAt?: string;
  latestCommand?: BridgeCommand; healthReport?: HealthReport;
};
const sessionPath = (id: string) => `${PREFIX}/sessions/${id}/session.json`;
const commandPath = (id: string) => `${PREFIX}/sessions/${id}/command.json`;

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
const STORE_NAME = "ux-direct-plugin-bridge";
function bridgeStore() {
  // Netlify Functions provide site identity and Blobs authorization automatically.
  return getStore(STORE_NAME, { region: "us-east-2" });
}
async function readJson<T>(pathname: string): Promise<T | null> {
  const value = await bridgeStore().get(pathname);
  if (value === null) return null;
  return JSON.parse(new TextDecoder().decode(value)) as T;
}
async function writeJson(pathname: string, value: unknown): Promise<void> {
  await bridgeStore().set(pathname, JSON.stringify(value), {
    metadata: { contentType: "application/json" },
  });
}
function publicSession(session: Session) {
  const { sessionToken: _neverExpose, ...safe } = session;
  return safe;
}
async function listSessions() {
  const result = await bridgeStore().list({ prefix: `${PREFIX}/sessions/` });
  const sessionBlobs = result.blobs.filter((blob) => blob.key.endsWith("/session.json"));
  const sessions = await Promise.all(sessionBlobs.map(async (blob) => {
    try { return await readJson<Session>(blob.key); } catch { return null; }
  }));
  const now = Date.now();
  return sessions.filter((session): session is Session => !!session && isAllowedFigmaFileKey(session.fileKey)).map((session) => ({
    ...publicSession(session),
    isOnline: session.status === "online" && now - Date.parse(session.lastHeartbeatAt) < 65000,
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
    if (mode === "sessions") return NextResponse.json({ sessions: await listSessions() }, { headers });
    if (mode === "state") {
      const parsedId = ID.safeParse(url.searchParams.get("clientId"));
      if (!parsedId.success) return NextResponse.json({ error: "A valid clientId is required." }, { status: 400, headers });
      const session = await readJson<Session>(sessionPath(parsedId.data));
      if (!session || !isAllowedFigmaFileKey(session.fileKey)) return NextResponse.json({ error: "Allowlisted plugin session not found." }, { status: 404, headers });
      const now = Date.now();
      return NextResponse.json({
        session: { ...publicSession(session), isOnline: session.status === "online" && now - Date.parse(session.lastHeartbeatAt) < 65000 }
      }, { headers });
    }
    return NextResponse.json({ error: "Unsupported bridge mode." }, { status: 400, headers });
  } catch (error) {
    console.error("[ux-direct-bridge] Netlify Blobs read failed", error);
    return NextResponse.json({ error: "Could not read bridge state from Netlify Blobs storage." }, { status: 500, headers });
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
  if (!isDashboardCommand && !isAllowedFigmaFileKey(body.fileKey)) {
    return NextResponse.json({ error: "Figma plugin request blocked: file key is not allowlisted." }, { status: 403, headers });
  }

  const idResult = ID.safeParse(body.clientId);
  if (!idResult.success) return NextResponse.json({ error: "A valid clientId is required." }, { status: 400, headers });
  const clientId = idResult.data;
  const path = sessionPath(clientId);

  try {
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
      const action = z.literal("native-api-health-check").safeParse(body.action);
      if (!action.success) return NextResponse.json({ error: "Unsupported plugin action." }, { status: 400, headers });
      const current = await readJson<Session>(path);
      if (!current || !isAllowedFigmaFileKey(current.fileKey)) return NextResponse.json({ error: "Allowlisted plugin session not found. Open UX Direct in Zunaid_Workspace first." }, { status: 404, headers });
      if (current.status !== "online" || Date.now() - Date.parse(current.lastHeartbeatAt) >= 65000) {
        return NextResponse.json({ error: "Figma plugin is offline. Open the plugin and try again." }, { status: 409, headers });
      }
      if (current.latestCommand && ["pending", "claimed"].includes(current.latestCommand.status)) {
        const commandAgeMs = Date.now() - Date.parse(current.latestCommand.issuedAt);
        if (Number.isFinite(commandAgeMs) && commandAgeMs < 180000) {
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
        commandId: crypto.randomUUID(), action: "native-api-health-check", status: "pending",
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 90000).toISOString(),
      };
      await writeJson(commandPath(clientId), command);
      current.latestCommand = command;
      await writeJson(path, current);
      recordOperationalEvent({
        source: "dashboard", event: "Plugin health check command issued", status: "info",
        summary: "Dashboard queued a native Figma API health check for the active plugin session.",
        requestId: command.commandId, action: action.data,
      });
      return NextResponse.json({ ok: true, commandId: command.commandId, status: "pending" }, { headers });
    }

    return NextResponse.json({ error: "Unsupported bridge mode." }, { status: 400, headers });
  } catch (error) {
    console.error("[ux-direct-bridge] Netlify Blobs request failed", error);
    return NextResponse.json({ error: "Bridge request failed while reading or writing Netlify Blobs storage." }, { status: 500, headers });
  }
}
