import { NextResponse } from "next/server";
import { z } from "zod";
import { readR2Json, writeR2Json } from "@/src/storage/r2-json-store";
import { ALLOWED_FIGMA_FILE_KEY, isAllowedFigmaFileKey } from "@/src/security/figma-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_URL = "https://agent.tinyfish.ai/v1/automation/run-sse";
const BRIDGE_PREFIX = "ux-direct-bridge";
const FIGMA_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
const CLIENT_ID = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
type StoredSession = { clientId: string; sessionToken: string; fileKey: string; status: "online" | "offline"; lastHeartbeatAt: string };
type LiveQALock = { state: "running" | "finished"; startedAt: string; finishedAt?: string; outputNodeId: string; phase: string };
type JsonRecord = Record<string, unknown>;

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || FIGMA_ORIGINS.has(origin);
}
function cors(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const ok = origin && (origin === new URL(request.url).origin || FIGMA_ORIGINS.has(origin));
  return {
    ...(ok ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function findReview(value: unknown, depth = 0): JsonRecord | null {
  if (depth > 5) return null;
  const candidate = parseJsonString(value);
  if (!isRecord(candidate)) return null;
  if (typeof candidate.score === "number" && Array.isArray(candidate.issues)) return candidate;
  for (const key of ["result", "output", "data", "structured_output", "structuredOutput", "answer", "response", "content", "json"]) {
    if (candidate[key] !== undefined) {
      const nested = findReview(candidate[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}
function validFrameUrl(raw: string, nodeId: string, fileKey: string): boolean {
  try {
    const url = new URL(raw);
    if (!["www.figma.com", "figma.com"].includes(url.hostname) || url.protocol !== "https:") return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "design" || segments[1] !== fileKey) return false;
    const requested = url.searchParams.get("node-id");
    return requested === nodeId.replace(/:/g, "-") || requested === nodeId;
  } catch { return false; }
}
function parseSseEvents(raw: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = parseJsonString(line.slice(5).trim());
    if (isRecord(value)) events.push(value);
  }
  return events;
}
function normalizeIssues(value: unknown): Array<{ severity: "high" | "medium" | "low"; issue: string; evidence: string; fix: string }> | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const issues: Array<{ severity: "high" | "medium" | "low"; issue: string; evidence: string; fix: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const severity = String(entry.severity || entry.priority || "medium").toLowerCase();
    const issue = String(entry.issue || entry.title || entry.problem || "").trim().slice(0, 240);
    const evidence = String(entry.evidence || entry.observation || entry.rationale || "").trim().slice(0, 300);
    const fix = String(entry.fix || entry.recommendation || entry.action || "").trim().slice(0, 300);
    if (!issue || !evidence || !fix) return null;
    issues.push({
      severity: /critical|blocker|high|major|p0|p1/.test(severity) ? "high" : /low|minor|nit|p3|p4/.test(severity) ? "low" : "medium",
      issue, evidence, fix,
    });
  }
  return issues;
}
export async function OPTIONS(request: Request) {
  const headers = cors(request);
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}
export async function POST(request: Request) {
  const headers = cors(request);
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers });
  const tinyfishKey = process.env.TINYFISH_API_KEY?.trim();
  if (!tinyfishKey) return NextResponse.json({ error: "TinyFish is not configured. Add TINYFISH_API_KEY as a Cloudflare Worker secret." }, { status: 503, headers });

  const body = await request.json().catch(() => null);
  const parsed = z.object({
    prompt: z.string().trim().min(2).max(5000),
    fileKey: z.string().trim().min(1).max(100),
    clientId: CLIENT_ID,
    sessionToken: z.string().trim().min(20).max(200),
    sourceNodeId: z.string().trim().min(1).max(100),
    outputNodeId: z.string().trim().min(1).max(100),
    sourceUrl: z.string().url().max(1000),
    outputUrl: z.string().url().max(1000),
    phase: z.enum(["initial", "verification"]),
  }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "TinyFish live QA input is invalid.", details: parsed.error.issues }, { status: 400, headers });
  const value = parsed.data;
  if (!isAllowedFigmaFileKey(value.fileKey) || value.fileKey !== ALLOWED_FIGMA_FILE_KEY ||
      !validFrameUrl(value.sourceUrl, value.sourceNodeId, value.fileKey) ||
      !validFrameUrl(value.outputUrl, value.outputNodeId, value.fileKey)) {
    return NextResponse.json({ error: "Live QA is restricted to source and output nodes in the approved Figma file." }, { status: 403, headers });
  }

  const session = await readR2Json<StoredSession>(BRIDGE_PREFIX + "/sessions/" + value.clientId + "/session.json").catch(() => null);
  if (!session || session.sessionToken !== value.sessionToken || session.clientId !== value.clientId ||
      session.fileKey !== value.fileKey || session.status !== "online" ||
      Date.now() - Date.parse(session.lastHeartbeatAt) >= 75000) {
    return NextResponse.json({ error: "The active Figma Desktop plugin session could not be verified. Reopen UX Direct and retry." }, { status: 409, headers });
  }

  const lockKey = BRIDGE_PREFIX + "/live-qa/" + value.clientId + "/active.json";
  const prior = await readR2Json<LiveQALock>(lockKey).catch(() => null);
  if (prior?.state === "running" && Date.now() - Date.parse(prior.startedAt) < 85000) {
    return NextResponse.json({ error: "A TinyFish visual scan is already running for this Figma session. Wait for it to finish." }, { status: 409, headers });
  }
  const startedAt = new Date().toISOString();
  await writeR2Json(lockKey, { state: "running", startedAt, outputNodeId: value.outputNodeId, phase: value.phase } satisfies LiveQALock);

  const profileId = process.env.TINYFISH_FIGMA_PROFILE_ID?.trim() || "prof_c893665f2aa64018";
  const outputSchema = {
    type: "object",
    properties: {
      score: { type: "number" }, summary: { type: "string" },
      issues: { type: "array", items: { type: "object", properties: {
        severity: { type: "string", enum: ["high", "medium", "low"] },
        issue: { type: "string" }, evidence: { type: "string" }, fix: { type: "string" },
      }, required: ["severity", "issue", "evidence", "fix"] } },
      sourceInspected: { type: "boolean" }, outputInspected: { type: "boolean" }, loginRequired: { type: "boolean" },
    },
    required: ["score", "summary", "issues", "sourceInspected", "outputInspected", "loginRequired"],
  };
  const goal = [
    "Perform a READ-ONLY visual QA comparison of two frames in the same signed-in Figma document. Do not modify, move, rename, or click any design editing controls.",
    "The browser starts at the source frame URL: " + value.sourceUrl,
    "Wait for Figma to load, inspect the rendered source canvas, and record actual labels, financial values, dates, outer card boundaries, status badge placement and progress indicators. sourceInspected=true only if the actual source canvas is visible; a login/loading/error page is not inspection.",
    "Then navigate to the output frame URL: " + value.outputUrl + " and wait for the output frame to render.",
    "Compare output with source for text fidelity, clipping, overlap, spacing, component hierarchy, card grouping, progress-ring geometry, contrast and excess whitespace. Each issue must state observed evidence and a specific minimal fix.",
    "Return structured JSON matching the supplied output schema. If Figma login is needed or either canvas is not visible, set loginRequired=true as appropriate and inspected booleans false, score=0, and do not guess at design quality.",
    "User request: " + value.prompt.slice(0, 3000),
  ].join("\n");

  let controller: AbortController | null = null;
  try {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 72000);
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "X-API-Key": tinyfishKey, "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({
          url: value.sourceUrl, goal, browser_profile: "lite", use_profile: true, profile_id: profileId,
          agent_config: { mode: "strict", max_steps: 14, max_duration_seconds: 55 },
          capture_config: { elements: true, snapshots: true, screenshots: true, recording: false, html: false },
          output_schema: outputSchema,
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return NextResponse.json({ error: "TinyFish rejected the live QA request (HTTP " + response.status + "). Check the API key and browser profile." }, { status: 502, headers });
      const raw = await response.text();
      const events = parseSseEvents(raw);
      const complete = [...events].reverse().find((event) => event.type === "COMPLETE");
      const failed = [...events].reverse().find((event) => event.type === "FAILED" || event.type === "ERROR");
      if (!complete || String(complete.status || "").toUpperCase() !== "COMPLETED") {
        const failedStatus = failed && typeof failed.status === "string" ? failed.status : "no completed result";
        return NextResponse.json({ error: "TinyFish live QA did not finish successfully (" + failedStatus + ")." }, { status: 502, headers });
      }
      const decoded = findReview(complete.result);
      if (!decoded) return NextResponse.json({ error: "TinyFish completed, but its result did not contain a structured QA report." }, { status: 502, headers });
      const issueList = normalizeIssues(decoded.issues);
      const scoreValue = Number(decoded.score);
      const summary = typeof decoded.summary === "string" ? decoded.summary.trim().slice(0, 500) : "";
      const sourceInspected = decoded.sourceInspected === true;
      const outputInspected = decoded.outputInspected === true;
      const loginRequired = decoded.loginRequired === true;
      if (!issueList || !Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 100 || !summary) {
        return NextResponse.json({ error: "TinyFish QA result failed validation; no automatic changes were made." }, { status: 502, headers });
      }
      if (loginRequired || !sourceInspected || !outputInspected) {
        return NextResponse.json({
          error: loginRequired ? "TinyFish cannot inspect Figma because its browser profile needs a Figma sign-in." :
            "TinyFish could not confirm both source and output canvases were visible; no repair was attempted.",
          review: { score: scoreValue, summary, issues: issueList, sourceInspected, outputInspected },
        }, { status: 424, headers });
      }
      return NextResponse.json({
        ok: true, provider: "tinyfish", phase: value.phase,
        runId: typeof complete.run_id === "string" ? complete.run_id : null,
        review: { score: scoreValue, summary, issues: issueList, sourceInspected, outputInspected },
      }, { headers });
    } finally { clearTimeout(timeout); }
  } catch (error) {
    return NextResponse.json({
      error: controller?.signal.aborted ? "TinyFish visual QA timed out; no repair was attempted." :
        "TinyFish visual QA request failed: " + (error instanceof Error ? error.message.slice(0, 180) : "network error"),
    }, { status: 502, headers });
  } finally {
    await writeR2Json(lockKey, { state: "finished", startedAt, finishedAt: new Date().toISOString(), outputNodeId: value.outputNodeId, phase: value.phase } satisfies LiveQALock).catch(() => {});
  }
}
