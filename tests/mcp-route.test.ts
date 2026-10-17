import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { POST } from "../app/api/mcp/route";

const testSecret = "ux-direct-test-oauth-secret-" + "x".repeat(32);
const testIssuer = "https://uxdirect.test";

function signAccessToken(scope = "ux:read ux:plan offline_access", secret = testSecret) {
  const payload = {
    typ: "access",
    iss: testIssuer,
    aud: testIssuer + "/api/mcp",
    resource: testIssuer + "/api/mcp",
    sub: "unit-test-user",
    client_id: "unit-test-client",
    scope,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

function request(body: unknown, options: { token?: string; origin?: string } = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (options.token) headers.set("authorization", "Bearer " + options.token);
  if (options.origin) headers.set("origin", options.origin);
  return new Request(testIssuer + "/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function withOAuthEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    secret: process.env.UX_DIRECT_MCP_OAUTH_SECRET,
    issuer: process.env.UX_DIRECT_MCP_ISSUER_URL,
  };
  process.env.UX_DIRECT_MCP_OAUTH_SECRET = testSecret;
  process.env.UX_DIRECT_MCP_ISSUER_URL = testIssuer;
  try {
    return await run();
  } finally {
    if (previous.secret === undefined) delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
    else process.env.UX_DIRECT_MCP_OAUTH_SECRET = previous.secret;
    if (previous.issuer === undefined) delete process.env.UX_DIRECT_MCP_ISSUER_URL;
    else process.env.UX_DIRECT_MCP_ISSUER_URL = previous.issuer;
  }
}

test("MCP endpoint fails closed when OAuth signing secret is not configured", async () => {
  const original = process.env.UX_DIRECT_MCP_OAUTH_SECRET;
  delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
  try {
    const response = await POST(request({
      jsonrpc: "2.0", id: 1, method: "initialize",
    }, { token: signAccessToken() }));
    assert.equal(response.status, 503);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
    else process.env.UX_DIRECT_MCP_OAUTH_SECRET = original;
  }
});

test("OAuth-authenticated client can initialize", async () => withOAuthEnv(async () => {
  const response = await POST(request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  }, { token: signAccessToken() }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.protocolVersion, "2025-11-25");
  assert.equal(body.result.serverInfo.name, "ux-direct");
  assert.ok(body.result.capabilities.tools);
}));

test("tool list is filtered to the permissions in the OAuth access token", async () => withOAuthEnv(async () => {
  const response = await POST(request({
    jsonrpc: "2.0", id: 2, method: "tools/list",
  }, { token: signAccessToken("ux:read ux:plan offline_access") }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.result.tools.map((tool: { name: string }) => tool.name), [
    "ux_direct_status",
    "ux_direct_connection_status",
    "ux_direct_figma_plugin_health_check_status",
    "ux_direct_plan_task",
  ]);
  const planner = body.result.tools.find((tool: { name: string }) => tool.name === "ux_direct_plan_task");
  assert.deepEqual(planner.inputSchema.properties.project.enum, ["general", "express-computers"]);
  assert.ok(!body.result.tools.some((tool: { name: string }) => tool.name === "ux_direct_figma_plugin_queue_health_check"));
}));

test("MCP endpoint rejects untrusted browser origins before tool execution", async () => withOAuthEnv(async () => {
  const response = await POST(request({
    jsonrpc: "2.0", id: 1, method: "ping",
  }, { token: signAccessToken(), origin: "https://not-trusted.example" }));
  assert.equal(response.status, 403);
}));

test("MCP endpoint rejects invalid OAuth access tokens", async () => withOAuthEnv(async () => {
  const response = await POST(request({
    jsonrpc: "2.0", id: 1, method: "ping",
  }, { token: "wrong-token" }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") || "", /oauth-protected-resource/);
}));

test("OAuth token without Figma diagnostic scope cannot queue a health check", async () => withOAuthEnv(async () => {
  const response = await POST(request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "ux_direct_figma_plugin_queue_health_check", arguments: {} },
  }, { token: signAccessToken("ux:read ux:plan") }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /figma:health/);
}));

test("connection-status tool documents its ChatGPT and Figma freshness windows", async () => withOAuthEnv(async () => {
  const response = await POST(request({
    jsonrpc: "2.0", id: 3, method: "tools/list",
  }, { token: signAccessToken("ux:read") }));
  const body = await response.json();
  const connectionTool = body.result.tools.find((tool: { name: string }) => tool.name === "ux_direct_connection_status");
  assert.ok(connectionTool);
  assert.match(connectionTool.description, /five minutes/);
  assert.match(connectionTool.description, /75 seconds/);
}));
