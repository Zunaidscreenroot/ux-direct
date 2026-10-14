import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/mcp/route";

const TEST_TOKEN = "test-ux-direct-mcp-token-that-is-not-a-real-secret";

function request(body: unknown, token = TEST_TOKEN) {
  return new Request("https://ux-direct.test/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("UX Direct MCP endpoint requires bearer authentication", async () => {
  const previous = process.env.UX_DIRECT_MCP_TOKEN;
  process.env.UX_DIRECT_MCP_TOKEN = TEST_TOKEN;
  try {
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "ping" }, ""));
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.UX_DIRECT_MCP_TOKEN;
    else process.env.UX_DIRECT_MCP_TOKEN = previous;
  }
});

test("UX Direct MCP handshake and tool discovery work without model or database calls", async () => {
  const previous = process.env.UX_DIRECT_MCP_TOKEN;
  process.env.UX_DIRECT_MCP_TOKEN = TEST_TOKEN;
  try {
    const initialized = await POST(request({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-client", version: "1" } },
    }));
    assert.equal(initialized.status, 200);
    const initJson = await initialized.json() as { result?: { protocolVersion?: string; capabilities?: { tools?: unknown } } };
    assert.equal(initJson.result?.protocolVersion, "2025-03-26");
    assert.ok(initJson.result?.capabilities?.tools);

    const listed = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    assert.equal(listed.status, 200);
    const listJson = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
    const names = (listJson.result?.tools || []).map(tool => tool.name);
    assert.deepEqual(names, ["ux_direct_consult", "ux_direct_teach", "ux_direct_search_memory"]);

    const blockedDmiMemory = await POST(request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "ux_direct_teach",
        arguments: { rule: "DMI loan flow includes a client-specific fee requirement." },
      },
    }));
    assert.equal(blockedDmiMemory.status, 200);
    const blockedJson = await blockedDmiMemory.json() as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(blockedJson.result?.isError, true);
    assert.match(blockedJson.result?.content?.[0]?.text || "", /DMI-specific client knowledge/);
  } finally {
    if (previous === undefined) delete process.env.UX_DIRECT_MCP_TOKEN;
    else process.env.UX_DIRECT_MCP_TOKEN = previous;
  }
});
