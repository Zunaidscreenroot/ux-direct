import test from "node:test";
import assert from "node:assert/strict";
import { POST, GET } from "../app/api/mcp/route";
import { signMcpPayload } from "../lib/mcp-oauth";

const validKey = "test-only-ux-direct-mcp-key-" + "x".repeat(32);

function request(body: unknown, options: { key?: string; origin?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (options.key) headers.set("authorization", `Bearer ${options.key}`);
  if (options.origin) headers.set("origin", options.origin);
  return new Request("https://uxdirect.test/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

test("MCP endpoint fails closed when OAuth and legacy API key are not configured", async () => {
  const originalKey = process.env.UX_DIRECT_MCP_API_KEY;
  const originalOAuth = process.env.UX_DIRECT_MCP_OAUTH_SECRET;
  delete process.env.UX_DIRECT_MCP_API_KEY;
  delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
  try {
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "initialize" }, { key: validKey }));
    assert.equal(response.status, 401);
  } finally {
    if (originalKey === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = originalKey;
    if (originalOAuth === undefined) delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
    else process.env.UX_DIRECT_MCP_OAUTH_SECRET = originalOAuth;
  }
});

test("MCP endpoint advertises OAuth resource metadata when called without a token", async () => {
  const response = await GET(new Request("https://uxdirect.test/api/mcp"));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") || "", /oauth-protected-resource/);
});

test("OAuth client can initialize with a valid resource-bound access token", async () => {
  const originalKey = process.env.UX_DIRECT_MCP_API_KEY;
  const originalOAuth = process.env.UX_DIRECT_MCP_OAUTH_SECRET;
  delete process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_OAUTH_SECRET = "oauth-test-secret-" + "z".repeat(48);
  try {
    const issuer = "https://uxdirect.test";
    const resource = issuer + "/api/mcp";
    const token = signMcpPayload({
      typ: "access", iss: issuer, aud: resource, resource,
      sub: "test-owner", client_id: "test-client",
      scope: "ux:read ux:execute ux:learn offline_access",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const response = await POST(request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ChatGPT OAuth test", version: "1.0" } },
    }, { key: token }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.serverInfo.name, "ux-direct");
  } finally {
    if (originalKey === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = originalKey;
    if (originalOAuth === undefined) delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
    else process.env.UX_DIRECT_MCP_OAUTH_SECRET = originalOAuth;
  }
});

test("OAuth tool discovery is scope-filtered and execution tools reject read-only tokens", async () => {
  const originalKey = process.env.UX_DIRECT_MCP_API_KEY;
  const originalOAuth = process.env.UX_DIRECT_MCP_OAUTH_SECRET;
  delete process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_OAUTH_SECRET = "oauth-test-secret-" + "z".repeat(48);
  try {
    const issuer = "https://uxdirect.test";
    const resource = issuer + "/api/mcp";
    const token = signMcpPayload({
      typ: "access", iss: issuer, aud: resource, resource, sub: "test-owner",
      client_id: "test-client", scope: "ux:read offline_access",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const listing = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { key: token }));
    const listed = await listing.json();
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes("ux_direct_uxaudit_discover_site"));
    assert.ok(!names.includes("ux_direct_uxaudit_run_benchmark"));
    const call = await POST(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ux_direct_uxaudit_run_benchmark", arguments: { clientName: "Ujjivan", clientUrl: "https://www.ujjivansfb.bank.in/", competitors: [{ name: "AU", url: "https://www.aubank.in/" }] } } }, { key: token }));
    const result = await call.json();
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /missing required scope ux:execute/);
  } finally {
    if (originalKey === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = originalKey;
    if (originalOAuth === undefined) delete process.env.UX_DIRECT_MCP_OAUTH_SECRET;
    else process.env.UX_DIRECT_MCP_OAUTH_SECRET = originalOAuth;
  }
});

test("authenticated client can initialize", async () => {
  const original = process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_API_KEY = validKey;
  try {
    const response = await POST(request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }, { key: validKey }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.protocolVersion, "2025-11-25");
    assert.equal(body.result.serverInfo.name, "ux-direct");
    assert.ok(body.result.capabilities.tools);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = original;
  }
});

test("tool list exposes status, safe UX planning, and shared brain operations", async () => {
  const original = process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_API_KEY = validKey;
  try {
    const response = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { key: validKey }));
    const body = await response.json();
    assert.deepEqual(body.result.tools.map((tool: { name: string }) => tool.name), [
      "ux_direct_status",
      "ux_direct_connection_status",
      "ux_direct_figma_plugin_queue_health_check",
      "ux_direct_figma_plugin_health_check_status",
      "ux_direct_plan_task",
      "ux_direct_brain_search",
      "ux_direct_brain_save_feedback",
      "ux_direct_brain_list_feedback",
      "ux_direct_brain_review_feedback",
      "ux_direct_brain_add_reference",
      "ux_direct_brain_list_references",
      "ux_direct_brain_review_reference",
      "ux_direct_brain_add_eval_case",
      "ux_direct_brain_review_eval_case",
      "ux_direct_brain_run_retrieval_evals",
      "ux_direct_uxaudit_status",
      "ux_direct_uxaudit_discover_site",
      "ux_direct_uxaudit_run_page_audit",
      "ux_direct_uxaudit_get_session_report",
      "ux_direct_uxaudit_generate_improved_ia",
      "ux_direct_uxaudit_run_benchmark",
    ]);
    const brainSave = body.result.tools.find((tool: { name: string }) => tool.name === "ux_direct_brain_save_feedback");
    assert.ok(brainSave.inputSchema.properties.rawFeedback);
    assert.ok(brainSave.inputSchema.properties.normalizedRule);
    assert.equal(brainSave.inputSchema.properties.sourceProduct.enum.includes("figma-plugin"), true);
    const planner = body.result.tools.find((tool: { name: string }) => tool.name === "ux_direct_plan_task");
    assert.deepEqual(planner.inputSchema.properties.project.enum, ["general", "express-computers"]);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = original;
  }
});

test("MCP endpoint rejects untrusted browser origins", async () => {
  const original = process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_API_KEY = validKey;
  try {
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "ping" }, { key: validKey, origin: "https://not-trusted.example" }));
    assert.equal(response.status, 403);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = original;
  }
});

test("MCP endpoint rejects invalid bearer keys", async () => {
  const original = process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_API_KEY = validKey;
  try {
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "ping" }, { key: "wrong-key" }));
    assert.equal(response.status, 401);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = original;
  }
});

test("connection-status tool reports ChatGPT and Figma connection semantics", async () => {
  const original = process.env.UX_DIRECT_MCP_API_KEY;
  process.env.UX_DIRECT_MCP_API_KEY = validKey;
  try {
    const response = await POST(request({
      jsonrpc: "2.0", id: 3, method: "tools/list",
    }, { key: validKey }));
    const body = await response.json();
    const connectionTool = body.result.tools.find((tool: { name: string }) => tool.name === "ux_direct_connection_status");
    assert.ok(connectionTool);
    assert.match(connectionTool.description, /five minutes/);
    assert.match(connectionTool.description, /75 seconds/);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = original;
  }
});
