import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: origin + "/api/mcp/oauth/authorize",
    token_endpoint: origin + "/api/mcp/oauth/token",
    registration_endpoint: origin + "/api/mcp/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp:tools"],
  }, { headers: { "Cache-Control": "no-store" } });
}
