import { randomUUID } from "node:crypto";
import {
  getMcpIssuer,
  getMcpSecret,
  readMcpEnv,
  htmlEscape,
  signMcpPayload,
  verifyMcpPayload,
  safeEqual,
  MCP_SCOPES,
} from "@/lib/mcp-oauth";

export const runtime = "nodejs";

type AuthorizeInput = {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  challenge: string;
  method: string;
  clientName: string;
  resource: string;
};

function getInput(values: URLSearchParams | FormData): AuthorizeInput | null {
  const val = (key: string) => String(values.get(key) || "");
  const clientId = val("client_id");
  const client = verifyMcpPayload(clientId.startsWith("uxdmcp_") ? clientId.slice(7) : "", "client");
  const redirectUri = val("redirect_uri");
  const state = val("state");
  const scope = val("scope") || "ux:read ux:plan figma:health offline_access";
  const challenge = val("code_challenge");
  const method = val("code_challenge_method");
  const resource = val("resource");
  const redirects = Array.isArray(client?.redirect_uris)
    ? client.redirect_uris.filter((value): value is string => typeof value === "string")
    : [];
  const requested = scope.split(/\s+/).filter(Boolean);

  if (
    !client ||
    !redirects.includes(redirectUri) ||
    val("response_type") !== "code" ||
    method !== "S256" ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
    state.length > 2048 ||
    requested.some((value) => !(MCP_SCOPES as readonly string[]).includes(value))
  ) return null;

  return {
    clientId,
    redirectUri,
    state,
    scope: [...new Set(requested)].join(" "),
    challenge,
    method,
    clientName: String(client.client_name || "ChatGPT MCP client"),
    resource,
  };
}

function htmlPage(issuer: string, input: AuthorizeInput, error = ""): Response {
  const hidden = [
    ["response_type", "code"],
    ["client_id", input.clientId],
    ["redirect_uri", input.redirectUri],
    ["state", input.state],
    ["scope", input.scope],
    ["code_challenge", input.challenge],
    ["code_challenge_method", input.method],
    ["resource", input.resource],
  ].map(([name, value]) =>
    '<input type="hidden" name="' + name + '" value="' + htmlEscape(value) + '">'
  ).join("");

  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect UX Direct</title>',
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fa;color:#182235;font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px}.card{width:min(100%,500px);border:1px solid #dce3ed;border-radius:18px;background:#fff;padding:30px;box-shadow:0 14px 48px #17203312}.brand{font-size:11px;font-weight:900;letter-spacing:.12em;color:#31598f}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:#172b49;color:#fff;font-weight:900;margin:16px 0}.muted{color:#637086;font-size:13px}.notice{background:#fff8e9;border:1px solid #e9cd8e;border-radius:9px;padding:10px;color:#815b12;font-size:12px}.field{display:grid;gap:6px;margin-top:17px}.field label{font-size:12px;font-weight:800}.field input{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}.checks{display:flex;gap:10px;margin:18px 0;color:#5d6b80;font-size:12px;align-items:flex-start}.checks input{margin-top:4px}button{width:100%;border:0;border-radius:9px;background:#1d3559;color:#fff;padding:13px;font-size:13px;font-weight:900;cursor:pointer}button:hover{background:#112747}.small{margin-top:15px;color:#78869a;font-size:11px;line-height:1.6}</style></head><body>',
    '<main class="card"><div class="brand">UX DIRECT · SECURE CONNECTION</div><div class="mark">UXD</div><h1>Connect ChatGPT to UX Direct</h1>',
    '<p class="muted"><strong>' + htmlEscape(input.clientName) + '</strong> is requesting access to your UX Direct workspace.</p>',
    '<div class="notice">This connection can read service and connection status, prepare UX task plans, and optionally run a Figma plugin API self-test. The self-test may create or reuse a persistent “UXD API Test Lab” page and fixtures in the approved Figma file. Task planning does not generate designs or execute writes.</div>',
    error ? '<p class="notice">' + htmlEscape(error) + '</p>' : "",
    '<form id="authorize-form" method="post" action="' + htmlEscape(issuer + "/api/mcp/oauth/authorize") + '" accept-charset="UTF-8">' + hidden,
    '<div class="field"><label for="password">UX Direct MCP connection code</label><input id="password" name="password" type="password" required autocomplete="current-password" autofocus></div>',
    '<div class="checks"><input id="consent" name="consent" type="checkbox" value="yes" required><label for="consent">I authorize this ChatGPT client to use the tools described above, within the permissions granted to the connection.</label></div>',
    '<button id="authorize-button" type="submit">Authorize ChatGPT</button></form>',
    '<p class="small">Only enter the private connection code you configured in Netlify. Keep it confidential. You can revoke existing tokens by rotating the OAuth signing secret and reconnecting.</p></main></body></html>',
  ].join("");

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://chat.openai.com; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: Request) {
  try {
    getMcpSecret();
    const issuer = getMcpIssuer(request);
    const input = getInput(new URL(request.url).searchParams);
    if (!input) {
      return new Response("Invalid OAuth authorization request. Restart the connection from ChatGPT.", {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }
    const resource = input.resource || issuer + "/api/mcp";
    if (resource !== issuer + "/api/mcp") {
      return new Response("The OAuth resource does not match this MCP server.", {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }
    return htmlPage(issuer, { ...input, resource });
  } catch {
    return new Response("UX Direct MCP OAuth is not configured on this deployment.", {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function POST(request: Request) {
  const issuer = getMcpIssuer(request);
  try {
    getMcpSecret();
    const form = await request.formData();
    const input = getInput(form);
    if (!input || form.get("consent") !== "yes") {
      return new Response("Invalid authorization request or consent was not provided.", {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }
    if (input.resource !== issuer + "/api/mcp") {
      return new Response("The OAuth resource does not match this MCP server.", {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }

    const expectedCode =
      readMcpEnv("UX_DIRECT_MCP_CONNECTION_CODE") ||
      readMcpEnv("UX_DIRECT_MCP_LOGIN_PASSWORD") ||
      readMcpEnv("UX_DIRECT_MCP_LOGIN_CODE");
    const suppliedCode = String(form.get("password") || "");
    if (!expectedCode || suppliedCode.length > 500 || !safeEqual(suppliedCode, expectedCode)) {
      console.warn("[ux-direct] mcp_oauth_authorize_code_rejected", JSON.stringify({
        expectedCodeConfigured: Boolean(expectedCode),
        suppliedLengthWithinLimit: suppliedCode.length <= 500,
      }));
      return htmlPage(issuer, input, "The connection code was not accepted. Please try again.");
    }

    const now = Math.floor(Date.now() / 1000);
    const code = signMcpPayload({
      typ: "code",
      jti: randomUUID(),
      iss: issuer,
      sub: "ux-direct-owner",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.challenge,
      scope: input.scope,
      resource: input.resource,
      iat: now,
      exp: now + 300,
    });

    const callback = new URL(input.redirectUri);
    callback.searchParams.set("code", code);
    if (input.state) callback.searchParams.set("state", input.state);
    callback.searchParams.set("iss", issuer);
    return Response.redirect(callback.toString(), 303);
  } catch (error) {
    console.error("[ux-direct] mcp_oauth_authorize_failed", JSON.stringify({
      error: error instanceof Error ? error.message : "unknown",
    }));
    return new Response("UX Direct MCP OAuth could not complete authorization.", {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
