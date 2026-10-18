import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { getMcpIssuer, signMcpPayload, verifyMcpPayload, getMcpSecret } from "@/lib/mcp-oauth";
export const runtime = "nodejs";
function badGrant(description = "The grant could not be validated.") {
  return Response.json({ error: "invalid_grant", error_description: description }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function tokenResponse(issuer: string, clientId: string, scope: string, resource: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: signMcpPayload({ typ: "access", jti: randomUUID(), iss: issuer, aud: resource, resource, sub: "ux-direct-owner", client_id: clientId, scope, iat: now, exp: now + 3600 }),
    token_type: "Bearer", expires_in: 3600,
    refresh_token: signMcpPayload({ typ: "refresh", jti: randomUUID(), iss: issuer, aud: resource, resource, sub: "ux-direct-owner", client_id: clientId, scope, iat: now, exp: now + 60 * 60 * 24 * 90 }),
    scope,
  };
}
export async function POST(request: Request) {
  try {
    getMcpSecret();
    const issuer = getMcpIssuer(request);
    const form = await request.formData();
    const grantType = String(form.get("grant_type") || "");
    const clientId = String(form.get("client_id") || "");
    const resource = String(form.get("resource") || issuer + "/api/mcp");
    if (resource !== issuer + "/api/mcp") return badGrant("The resource identifier does not match this MCP server.");
    if (!clientId.startsWith("uxmcp_") || !verifyMcpPayload(clientId.slice(6), "client")) {
      return Response.json({ error: "invalid_client" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if (grantType === "authorization_code") {
      const code = String(form.get("code") || "");
      const redirectUri = String(form.get("redirect_uri") || "");
      const verifier = String(form.get("code_verifier") || "");
      const claims = verifyMcpPayload(code, "code");
      const challenge = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ? createHash("sha256").update(verifier).digest("base64url") : "";
      if (!claims || claims.iss !== issuer || claims.client_id !== clientId || claims.redirect_uri !== redirectUri || claims.resource !== resource || !challenge || !equal(challenge, String(claims.code_challenge || ""))) return badGrant();
      return Response.json(tokenResponse(issuer, clientId, String(claims.scope || "ux:read"), resource), { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
    }
    if (grantType === "refresh_token") {
      const refresh = verifyMcpPayload(String(form.get("refresh_token") || ""), "refresh");
      if (!refresh || refresh.iss !== issuer || refresh.client_id !== clientId || refresh.resource !== resource) return badGrant("The refresh token is invalid or expired. Reconnect ChatGPT to UX Direct.");
      return Response.json(tokenResponse(issuer, clientId, String(refresh.scope || "ux:read"), resource), { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ux-direct] mcp_oauth_token_failed", JSON.stringify({ error: error instanceof Error ? error.message : "unknown" }));
    return Response.json({ error: "server_error", error_description: "The token service is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
