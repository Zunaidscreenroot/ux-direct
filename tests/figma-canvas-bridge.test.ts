import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const mcp = read("app/api/mcp/route.ts");
const bridge = read("app/api/plugin-bridge/route.ts");
const plugin = read("figma-plugin/code.js");
const pluginUi = read("figma-plugin/ui.html");

test("MCP exposes bounded canvas read, constrained write, and command status tools", () => {
  assert.ok(mcp.includes('name: "ux_direct_figma_canvas_read"'));
  assert.ok(mcp.includes('name: "ux_direct_figma_canvas_write"'));
  assert.ok(mcp.includes('name: "ux_direct_figma_canvas_command_status"'));
  assert.ok(mcp.includes('"ux_direct_figma_canvas_write"'));
  assert.ok(mcp.includes('maxNodes: { type: "integer", minimum: 1, maximum: 100'));
});

test("canvas write tool requires explicit confirmation and supports only named operations", () => {
  assert.ok(mcp.includes('if (input.confirm !== true)'));
  assert.ok(mcp.includes('operation: { type: "string", enum: ["create-elements", "update-node"] }'));
  assert.ok(mcp.includes('enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT"]'));
  assert.ok(mcp.includes('target=test-lab'));
  assert.ok(!mcp.includes('figma.deleteNode'));
});

test("bridge authenticates server-issued commands and strictly validates write payloads", () => {
  assert.ok(bridge.includes('request.headers.get("x-ux-direct-internal") !== internalSecret'));
  assert.ok(bridge.includes('confirm: z.literal(true)'));
  assert.ok(bridge.includes('z.array(CANVAS_ELEMENT).min(1).max(20)'));
  assert.ok(bridge.includes('!["read-canvas", "write-canvas"].includes(command.action)'));
  assert.ok(bridge.includes('serializedResult.length > 60000'));
});

test("native plugin checks the approved file before canvas access and caps reads", () => {
  assert.ok(plugin.includes('assertUxDirectFileScope("read canvas")'));
  assert.ok(plugin.includes('assertUxDirectFileScope("write canvas")'));
  assert.ok(plugin.includes('Math.min(4, Number.isInteger(payload.maxDepth)'));
  assert.ok(plugin.includes('Math.min(100, Number.isInteger(payload.maxNodes)'));
  assert.ok(plugin.includes('type === "run-canvas-command"'));
  assert.ok(plugin.includes('figma.currentPage.findOne(function (item) { return item.id === payload.nodeId; })'));
});

test("plugin UI dispatches only recognized command types and reports the result to the bridge", () => {
  assert.ok(pluginUi.includes('command.action === "read-canvas" || command.action === "write-canvas"'));
  assert.ok(pluginUi.includes('mode: "canvas-result"'));
  assert.ok(pluginUi.includes('operationError: message.error || undefined'));
});
