import { getMcpIssuer } from "@/lib/mcp-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const issuer = getMcpIssuer(request);
  return Response.json(
    {
      issuer,
      authorization_endpoint: issuer + "/api/mcp/oauth/authorize",
      token_endpoint: issuer + "/api/mcp/oauth/token",
      registration_endpoint: issuer + "/api/mcp/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["ux:read", "ux:execute", "ux:execute", "ux:learn", "offline_access"],
      service_documentation: "https://github.com/Zunaidscreenroot/ux-direct",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
