import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/mcp/route";

const validKey = "test-only-ux-direct-mcp-key-" + "x".repeat(32);

function request(body: unknown, options: { key?: string; origin?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (options.key) headers.set("authorization", `Bearer ${options.key}`);
  if (options.origin) headers.set("origin", options.origin);
  return new Request("https://uxdirect.test/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

test("MCP endpoint fails closed when its API key is not configured", async () => {
  const original = process.env.UX_DIRECT_MCP_API_KEY;
  delete process.env.UX_DIRECT_MCP_API_KEY;
  try {
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "initialize" }, { key: validKey }));
    assert.equal(response.status, 503);
  } finally {
    if (original === undefined) delete process.env.UX_DIRECT_MCP_API_KEY;
    else process.env.UX_DIRECT_MCP_API_KEY = original;
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
