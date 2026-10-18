import { NextResponse } from "next/server";
import { clientIdForRedirect, isAllowedRedirectUri } from "@/src/mcp/oauth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 });
  const input = body as Record<string, unknown>;
  const redirects = input.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length !== 1 || typeof redirects[0] !== "string" || !isAllowedRedirectUri(redirects[0])) {
    return NextResponse.json({ error: "invalid_redirect_uri", error_description: "Register exactly one HTTPS ChatGPT redirect URI (localhost HTTP is allowed for local development)." }, { status: 400 });
  }
  const redirectUri = redirects[0];
  return NextResponse.json({
    client_id: clientIdForRedirect(redirectUri),
    client_name: typeof input.client_name === "string" ? input.client_name.slice(0, 100) : "UX Direct",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp:tools",
  }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
