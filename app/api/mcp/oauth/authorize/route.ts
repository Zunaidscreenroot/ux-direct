import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIdForRedirect, isAllowedRedirectUri, issueOAuthToken } from "@/src/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function equalSecret(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
function htmlEscape(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;"); }
function safeParams(url: URL) {
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const method = url.searchParams.get("code_challenge_method") ?? "";
  if (!isAllowedRedirectUri(redirectUri) || clientId !== clientIdForRedirect(redirectUri) || !state || state.length > 1000 || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || method !== "S256") return null;
  return { clientId, redirectUri, state, challenge };
}
export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = safeParams(url);
  if (!params) return NextResponse.json({ error: "invalid_request", error_description: "Invalid client, redirect URI, state, or PKCE parameters." }, { status: 400 });
  const clientId = htmlEscape(params.clientId), redirectUri = htmlEscape(params.redirectUri), state = htmlEscape(params.state), challenge = htmlEscape(params.challenge);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect UX Direct</title></head><body style="font:16px system-ui;max-width:560px;margin:48px auto;padding:0 20px;color:#172033"><h1>Connect UX Direct</h1><p>Authorize ChatGPT to use UX Direct tools for status checks, UX task planning, and the Figma plugin health check.</p><p><strong>Safety:</strong> this grants the connected client access to the tools listed above. Do not enter a model-provider key or Figma personal access token.</p><form method="post" action="/api/mcp/oauth/authorize"><input type="hidden" name="client_id" value="${clientId}"><input type="hidden" name="redirect_uri" value="${redirectUri}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code_challenge" value="${challenge}"><label for="key">UX Direct connection approval key</label><br><input id="key" name="approval_key" type="password" autocomplete="current-password" required style="box-sizing:border-box;width:100%;padding:12px;margin:12px 0"><button type="submit" style="padding:12px 18px">Authorize connection</button></form><p style="color:#596579;font-size:13px">The key is checked server-side and is not stored or included in the redirect.</p></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${url.origin}; base-uri 'none'; frame-ancestors 'none'` } });
}
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const challenge = String(form.get("code_challenge") ?? "");
  const approvalKey = String(form.get("approval_key") ?? "");
  const expected = process.env.UX_DIRECT_MCP_OAUTH_APPROVAL_KEY || process.env.UX_DIRECT_MCP_API_KEY || "";
  if (expected.length < 32 || !equalSecret(approvalKey, expected)) return new Response("Invalid approval key. Return to the connection page and try again.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (!isAllowedRedirectUri(redirectUri) || clientId !== clientIdForRedirect(redirectUri) || !state || state.length > 1000 || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const code = issueOAuthToken({ typ: "code", exp: Math.floor(Date.now() / 1000) + 120, client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256" });
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  return NextResponse.redirect(callback, 303);
}
