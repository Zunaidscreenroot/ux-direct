import { randomUUID, timingSafeEqual } from "node:crypto";
import { CHATGPT_CIMD_CLIENT_ID, getMcpIssuer, getMcpSecret, readMcpEnv, htmlEscape, signMcpPayload, verifyMcpPayload, MCP_SCOPES, isChatGptCimdClientId } from "@/lib/mcp-oauth";
export const runtime = "nodejs";
type OAuthClientMetadata = {
  client_id?: unknown;
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
};
type AuthorizeInput = { clientId: string; redirectUri: string; state: string; scope: string; challenge: string; method: string; clientName: string; resource: string };
const CHATGPT_STABLE_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

async function resolveOAuthClient(clientId: string): Promise<OAuthClientMetadata | null> {
  if (clientId.startsWith("uxmcp_")) {
    return verifyMcpPayload(clientId.slice(6), "client") as OAuthClientMetadata | null;
  }
  if (!isChatGptCimdClientId(clientId)) return null;

  // Resolve only the known ChatGPT CIMD URL. Never fetch an arbitrary client_id URL.
  try {
    const response = await fetch(CHATGPT_CIMD_CLIENT_ID, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || !(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) return null;
    const raw = await response.text();
    if (raw.length > 16_384) return null;
    const metadata = JSON.parse(raw) as OAuthClientMetadata;
    const redirects = Array.isArray(metadata.redirect_uris)
      ? metadata.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    const methods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
      ? metadata.token_endpoint_auth_methods_supported.filter((value): value is string => typeof value === "string")
      : [];
    if (metadata.client_id !== CHATGPT_CIMD_CLIENT_ID ||
        !redirects.includes(CHATGPT_STABLE_REDIRECT_URI) ||
        (!methods.includes("none") && metadata.token_endpoint_auth_method !== "none")) return null;
    return metadata;
  } catch {
    return null;
  }
}

async function getInput(values: URLSearchParams | FormData): Promise<AuthorizeInput | null> {
  const val = (key: string) => String(values.get(key) || "");
  const clientId = val("client_id");
  const client = await resolveOAuthClient(clientId);
  const redirectUri = val("redirect_uri"), state = val("state");
  const scope = val("scope") || "ux:read ux:execute ux:learn offline_access";
  const challenge = val("code_challenge"), method = val("code_challenge_method"), resource = val("resource");
  const redirects = Array.isArray(client?.redirect_uris) ? client.redirect_uris.filter((x): x is string => typeof x === "string") : [];
  const requested = [...new Set([...scope.split(/\s+/).filter(Boolean), "ux:learn"])];
  if (!client || !redirects.includes(redirectUri) || val("response_type") !== "code" || method !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || !state || state.length > 2048 ||
      requested.some(value => !(MCP_SCOPES as readonly string[]).includes(value))) return null;
  return {
    clientId, redirectUri, state, scope: [...new Set(requested)].join(" "),
    challenge, method, clientName: String(client.client_name || "ChatGPT MCP client"), resource,
  };
}
function htmlPage(issuer: string, input: AuthorizeInput, error = ""): Response {
  const hidden = [
    ["response_type", "code"], ["client_id", input.clientId], ["redirect_uri", input.redirectUri],
    ["state", input.state], ["scope", input.scope], ["code_challenge", input.challenge],
    ["code_challenge_method", input.method], ["resource", input.resource],
  ].map(([name, value]) => '<input type="hidden" name="' + name + '" value="' + htmlEscape(value) + '">').join("");
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect UX Direct</title>',
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fa;color:#182235;font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px}.card{width:min(100%,480px);border:1px solid #dce3ed;border-radius:18px;background:#fff;padding:30px;box-shadow:0 14px 48px #17203312}.brand{font-size:11px;font-weight:900;letter-spacing:.12em;color:#31598f}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:#172b49;color:#fff;font-weight:900;margin:16px 0}.muted{color:#637086;font-size:13px}.notice{background:#fff8e9;border:1px solid #e9cd8e;border-radius:9px;padding:10px;color:#815b12;font-size:12px}.field{display:grid;gap:6px;margin-top:17px}.field label{font-size:12px;font-weight:800}.field input{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}.checks{display:flex;gap:10px;margin:18px 0;color:#5d6b80;font-size:12px}.checks input{margin-top:4px}button{width:100%;border:0;border-radius:9px;background:#1d3559;color:#fff;padding:13px;font-size:13px;font-weight:900;cursor:pointer}button:hover{background:#112747}button:disabled{opacity:.7;cursor:wait}.small{margin-top:15px;color:#78869a;font-size:11px;line-height:1.6}</style></head><body>',
    '<main class="card"><div class="brand">UX DIRECT · SECURE CONNECTION</div><div class="mark">UX</div><h1>Connect ' + htmlEscape(input.clientName) + ' to UX Direct</h1>',
    '<p class="muted"><strong>' + htmlEscape(input.clientName) + '</strong> is requesting access to your UX Direct workspace.</p>',
    '<div class="notice">UX Direct can invoke UX Audit workflows and use your shared UX knowledge. Screenshot audits and benchmarking may incur upstream model charges depending on the configured service provider.</div>',
    error ? '<p class="notice">' + htmlEscape(error) + '</p>' : "",
    '<form id="authorize-form" method="post" action="' + htmlEscape(issuer + "/api/mcp/oauth/authorize") + '" accept-charset="UTF-8">' + hidden,
    '<div class="field"><label for="password">UX Direct MCP connection code</label><input id="password" name="password" type="password" required autocomplete="current-password" autofocus></div>',
    '<div class="checks"><input id="consent" name="consent" type="checkbox" value="yes" required><label for="consent">I approve access to UX Direct shared knowledge, public-site IA discovery, desktop/mobile audits, competitor benchmarking, saved audit reports, and reviewable IA proposals. Audit and learning actions may write to the shared product database.</label></div>',
    '<button id="authorize-button" type="submit">Authorize ' + htmlEscape(input.clientName) + '</button></form>',
    '<p id="submit-status" class="small" role="status" aria-live="polite"></p>',
    '<script>var f=document.getElementById("authorize-form");if(f){f.addEventListener("submit",function(){var b=document.getElementById("authorize-button");var s=document.getElementById("submit-status");if(b){b.textContent="Authorizing…";}if(s){s.textContent="Submitting authorization securely. You should return to your MCP client shortly.";}window.setTimeout(function(){if(s&&document.visibilityState==="visible"){s.textContent="Still waiting for the server. If this page does not redirect, reload and try again.";if(b){b.textContent="Retry authorization";}}},8000);});}</script>',
    '<p class="small">UX Direct can store audit findings and approved learning. Proposed IA does not change a live website. Revoke this connection by rotating UX_DIRECT_MCP_OAUTH_SECRET in Cloudflare. Keep the connection code private.</p></main></body></html>',
  ].join("");
  // The browser applies form-action to the post-submit redirect, so allow the
  // registered callback's origin (already validated against the client metadata).
  const callbackOrigin = new URL(input.redirectUri).origin;
  return new Response(html, { status: 200, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' " + callbackOrigin + "; base-uri 'none'; frame-ancestors 'none'",
  }});
}
export async function GET(request: Request) {
  try {
    getMcpSecret();
    const issuer = getMcpIssuer(request);
    const input = await getInput(new URL(request.url).searchParams);
    if (!input) return new Response("Invalid OAuth authorization request. Restart the connection from your MCP client.", { status: 400, headers: { "Cache-Control": "no-store" } });
    const resource = input.resource || issuer + "/api/mcp";
    if (resource !== issuer + "/api/mcp") return new Response("The OAuth resource does not match this MCP server.", { status: 400, headers: { "Cache-Control": "no-store" } });
    return htmlPage(issuer, { ...input, resource });
  } catch {
    return new Response("UX Direct MCP OAuth is not configured on this deployment.", { status: 503 });
  }
}
export async function POST(request: Request) {
  const issuer = getMcpIssuer(request);
  try {
    getMcpSecret();
    const form = await request.formData();
    console.info("[ux-direct] mcp_oauth_authorize_post_received");
    const input = await getInput(form);
    if (!input || form.get("consent") !== "yes") {
      console.warn("[ux-direct] mcp_oauth_authorize_invalid_form");
      return new Response("Invalid authorization request or consent was not provided.", { status: 400 });
    }
    if (input.resource !== issuer + "/api/mcp") {
      console.warn("[ux-direct] mcp_oauth_authorize_resource_mismatch");
      return new Response("The OAuth resource does not match this MCP server.", { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const expectedPassword = readMcpEnv("UX_DIRECT_MCP_CONNECTION_CODE");
    const suppliedPassword = String(form.get("password") || "");
    const actual = Buffer.from(suppliedPassword), expected = Buffer.from(expectedPassword);
    if (!expectedPassword || suppliedPassword.length > 500 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      console.warn("[ux-direct] mcp_oauth_authorize_code_rejected", JSON.stringify({ expectedCodeConfigured: Boolean(expectedPassword), lengthsMatch: actual.length === expected.length, suppliedLengthWithinLimit: suppliedPassword.length <= 500 }));
      return htmlPage(issuer, input, "The connection code was not accepted. Please try again.");
    }
    const now = Math.floor(Date.now() / 1000);
    const code = signMcpPayload({
      typ: "code", jti: randomUUID(), iss: issuer, sub: "ux-direct-owner", client_id: input.clientId,
      redirect_uri: input.redirectUri, code_challenge: input.challenge, scope: input.scope,
      resource: input.resource, iat: now, exp: now + 300,
    });
    const callback = new URL(input.redirectUri);
    callback.searchParams.set("code", code);
    if (input.state) callback.searchParams.set("state", input.state);
    callback.searchParams.set("iss", issuer);
    console.info("[ux-direct] mcp_oauth_authorize_redirect", JSON.stringify({ callbackHost: callback.hostname, issuerIncluded: true }));
    return Response.redirect(callback.toString(), 303);
  } catch (error) {
    console.error("[ux-direct] mcp_oauth_authorize_failed", JSON.stringify({ error: error instanceof Error ? error.message : "unknown" }));
    return new Response("UX Direct MCP OAuth could not complete authorization.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
