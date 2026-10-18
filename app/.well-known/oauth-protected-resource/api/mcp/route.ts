import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    resource: origin + "/api/mcp",
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:tools"],
  }, { headers: { "Cache-Control": "no-store" } });
}
