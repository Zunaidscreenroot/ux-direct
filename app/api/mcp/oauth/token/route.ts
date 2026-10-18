import { NextResponse } from "next/server";
import { clientIdForRedirect, isAllowedRedirectUri, issueOAuthToken, pkceS256, verifyOAuthToken } from "@/src/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const grantType = String(form.get("grant_type") ?? "");
  if (grantType !== "authorization_code") return NextResponse.json({ error: "unsupported_grant_type", error_description: "Only authorization_code is supported; reconnect to renew access." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const code = String(form.get("code") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const claims = verifyOAuthToken(code);
  if (!claims || claims.typ !== "code" || !isAllowedRedirectUri(redirectUri) || claims.redirect_uri !== redirectUri || claims.client_id !== clientId || clientId !== clientIdForRedirect(redirectUri) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || claims.code_challenge !== pkceS256(verifier)) {
    return NextResponse.json({ error: "invalid_grant", error_description: "Authorization code is invalid, expired, or failed PKCE verification." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const resource = new URL("/api/mcp", request.url).toString();
  const accessToken = issueOAuthToken({ typ: "access", aud: resource, exp: Math.floor(Date.now() / 1000) + 3600, scope: "mcp:tools" });
  return NextResponse.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" }, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
}
