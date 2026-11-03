import { NextResponse } from "next/server";
import { readR2Json } from "@/src/storage/r2-json-store";
import { isAllowedFigmaFileKey } from "@/src/security/figma-access";
import {
  getConfiguredProvider,
  getProviderSwitcherState,
  getResolvedActiveChatProvider,
  isSupportedRuntimeChatProvider,
  setActiveChatProviderPreference,
} from "@/src/providers/runtime-chat-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLUGIN_ORIGINS = new Set(["https://www.figma.com", "https://figma.com", "null"]);
const CLIENT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const SESSION_PREFIX = "ux-direct-bridge/sessions/";

type PluginSession = {
  clientId: string;
  sessionToken: string;
  fileKey: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const selfOrigin = new URL(request.url).origin;
  const allowed = origin && (origin === selfOrigin || PLUGIN_ORIGINS.has(origin)) ? origin : selfOrigin;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin || PLUGIN_ORIGINS.has(origin);
}

function isPluginOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && PLUGIN_ORIGINS.has(origin);
}

function pluginFileKeyAllowed(request: Request, fileKey: unknown): boolean {
  const origin = request.headers.get("origin");
  if (origin && PLUGIN_ORIGINS.has(origin)) return isAllowedFigmaFileKey(fileKey);
  return fileKey === undefined || isAllowedFigmaFileKey(fileKey);
}

export async function OPTIONS(request: Request) {
  if (!originAllowed(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(request) });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!originAllowed(request)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: corsHeaders(request) });
  }
  const fileKey = url.searchParams.get("fileKey") || undefined;
  if (!pluginFileKeyAllowed(request, fileKey)) {
    return NextResponse.json({ error: "Approved Figma file key required." }, { status: 403, headers: corsHeaders(request) });
  }

  if (url.searchParams.get("warm") === "1") {
    return NextResponse.json(await warmFreeLlmApi(), { headers: corsHeaders(request) });
  }

  const [state, r2Ready] = await Promise.all([
    getProviderSwitcherState(),
    readR2Json("ux-direct-settings/active-chat-provider.json")
      .then(() => true)
      .catch(() => false),
  ]);
  return NextResponse.json({ ...state, preferenceStoreAvailable: r2Ready }, { headers: corsHeaders(request) });
}

/**
 * Wake a sleeping FreeLLMAPI host (e.g. Render Free) before the first Figma task, so the
 * cold start is not spent inside a model attempt. Never returns the key or upstream bodies.
 */
async function warmFreeLlmApi() {
  const provider = await getResolvedActiveChatProvider();
  if (provider.id !== "freellmapi") return { ok: true, provider: provider.id, skipped: true };
  if (!provider.configured) return { ok: false, provider: provider.id, error: provider.configurationError || "FreeLLMAPI is not configured." };
  const startedAt = Date.now();
  try {
    const response = await fetch(provider.baseUrl + "/models", {
      headers: { Authorization: "Bearer " + provider.apiKey, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(90_000),
    });
    const ms = Date.now() - startedAt;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, provider: provider.id, ms, status: response.status,
        error: "FreeLLMAPI rejected the unified key. If it worked before, the host probably restarted and lost its SQLite data (provider keys and unified key). Re-add the provider keys, create a new unified key and update the FREELLMAPI_API_KEY Worker secret." };
    }
    if (!response.ok) return { ok: false, provider: provider.id, ms, status: response.status, error: "FreeLLMAPI responded with HTTP " + response.status + "." };
    const payload = await response.json().catch(() => null) as { data?: unknown } | null;
    const modelCount = payload && Array.isArray(payload.data) ? payload.data.length : null;
    if (modelCount === 0) {
      return { ok: false, provider: provider.id, ms, modelCount,
        error: "FreeLLMAPI is awake but has no enabled models. Add provider keys in its dashboard; if they were there before, the host lost its stored data on restart." };
    }
    return { ok: true, provider: provider.id, ms, modelCount };
  } catch {
    return { ok: false, provider: provider.id, ms: Date.now() - startedAt, error: "FreeLLMAPI did not respond within 90 seconds." };
  }
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  if (!isPluginOrigin(request)) {
    return NextResponse.json({ error: "Figma plugin origin required." }, { status: 403, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers });
  }

  const fileKey = body.fileKey;
  const clientId = body.clientId;
  const sessionToken = body.sessionToken;
  const providerId = body.provider;

  if (!isAllowedFigmaFileKey(fileKey)) {
    return NextResponse.json({ error: "Provider switch blocked: Figma file is not allowlisted." }, { status: 403, headers });
  }
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) {
    return NextResponse.json({ error: "A valid Figma plugin session clientId is required." }, { status: 400, headers });
  }
  if (typeof sessionToken !== "string" || sessionToken.length < 20 || sessionToken.length > 200) {
    return NextResponse.json({ error: "A valid Figma plugin session token is required." }, { status: 400, headers });
  }
  if (!isSupportedRuntimeChatProvider(providerId)) {
    return NextResponse.json({ error: "Provider must be openrouter or freellmapi." }, { status: 400, headers });
  }

  try {
    const session = await readR2Json<PluginSession>(SESSION_PREFIX + clientId + "/session.json");
    const heartbeatAt = session?.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : NaN;
    const ageMs = Date.now() - heartbeatAt;
    if (!session || session.clientId !== clientId || session.sessionToken !== sessionToken ||
        !isAllowedFigmaFileKey(session.fileKey) || session.fileKey !== fileKey ||
        session.status !== "online" || !Number.isFinite(heartbeatAt) || ageMs < 0 || ageMs >= 75_000) {
      return NextResponse.json({ error: "The active Figma plugin session could not be verified. Refresh the connection status and try again." }, { status: 403, headers });
    }

    const target = getConfiguredProvider(providerId);
    if (!target.configured) {
      return NextResponse.json({
        error: target.configurationError || target.label + " is not configured on the backend.",
        ...(await getProviderSwitcherState()),
      }, { status: 409, headers });
    }

    await setActiveChatProviderPreference(providerId);
    return NextResponse.json(await getProviderSwitcherState(), { headers });
  } catch (error) {
    console.error("[ux-direct-provider] Provider switch failed", error);
    return NextResponse.json({
      error: "Could not persist the provider selection to Cloudflare R2. The active provider was not changed.",
    }, { status: 503, headers });
  }
}
