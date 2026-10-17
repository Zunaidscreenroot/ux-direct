import { randomUUID } from "node:crypto";
import { getMcpSecret, signMcpPayload } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2048) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    getMcpSecret();
    const body = await request.json();
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? [...new Set(body.redirect_uris)].slice(0, 10)
      : [];
    if (!redirectUris.length || !redirectUris.every(validRedirect)) {
      return Response.json({
        error: "invalid_client_metadata",
        error_description: "One or more HTTPS redirect_uris are missing or invalid.",
      }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const clientName = typeof body?.client_name === "string"
      ? body.client_name.trim().slice(0, 160)
      : "ChatGPT MCP client";
    const clientId = "uxdmcp_" + signMcpPayload({
      typ: "client",
      sub: randomUUID(),
      client_name: clientName || "ChatGPT MCP client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      created_at: new Date().toISOString(),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5,
    });

    return Response.json({
      client_id: clientId,
      client_name: clientName || "ChatGPT MCP client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ux-direct] mcp_oauth_register_failed", JSON.stringify({
      error: error instanceof Error ? error.message : "unknown",
    }));
    return Response.json({
      error: "server_error",
      error_description: "UX Direct MCP OAuth is not configured.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
