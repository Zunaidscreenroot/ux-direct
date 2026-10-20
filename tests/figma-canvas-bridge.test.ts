import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const mcp = read("app/api/mcp/route.ts");
const bridge = read("app/api/plugin-bridge/route.ts");
const plugin = read("figma-plugin/code.js");
const pluginUi = read("figma-plugin/ui.html");

test("conversational cockpit inline JavaScript parses successfully", () => {
  const match = pluginUi.match(/<script>([\\s\\S]*?)<\\/script>/i);
  assert.ok(match, "Figma plugin UI must contain its main script block.");
  assert.doesNotThrow(() => new Script(match[1], { filename: "figma-plugin/ui.html" }));
});

test("Figma execution remains implemented but is hidden from ChatGPT's tool list", () => {
  assert.ok(mcp.includes('name: "ux_direct_figma_canvas_read"'));
  assert.ok(mcp.includes('name: "ux_direct_figma_canvas_write"'));
  assert.ok(mcp.includes('name: "ux_direct_figma_canvas_command_status"'));
  assert.ok(mcp.includes("const CHATGPT_SUPERVISOR_HIDDEN_TOOLS = new Set(["));
  assert.ok(mcp.includes('"ux_direct_figma_canvas_read"'));
  assert.ok(mcp.includes('"ux_direct_figma_canvas_write"'));
  assert.ok(mcp.includes('"ux_direct_plan_task"'));
  assert.ok(mcp.includes('].filter((tool) => !CHATGPT_SUPERVISOR_HIDDEN_TOOLS.has(tool.name));'));
  assert.ok(mcp.includes('maxNodes: { type: "integer", minimum: 1, maximum: 100'));
});

test("canvas write tool requires explicit confirmation and supports only named operations", () => {
  assert.ok(mcp.includes('if (input.confirm !== true)'));
  assert.ok(mcp.includes('"clone-node", "delete-node", "reorder-node"'));
  assert.ok(mcp.includes('"reparent-node", "group-nodes", "flatten-nodes", "boolean-operation"'));
  assert.ok(mcp.includes('"create-component", "create-component-set", "create-instance", "swap-component"'));
  assert.ok(mcp.includes('"rename-page", "set-current-page", "export-svg"'));
  assert.ok(mcp.includes('"set-selection", "zoom-to-nodes"'));
  assert.ok(mcp.includes('"create-page", "rename-page", "set-current-page"'));
  assert.ok(mcp.includes('"export-svg", "export-node", "apply-style"'));
  assert.ok(mcp.includes('enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "LINE", "POLYGON", "STAR", "SLICE", "VECTOR"]'));
  assert.ok(mcp.includes('textAlignHorizontal: { type: "string", enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] }'));
  assert.ok(mcp.includes('paddingLeft: { type: "number", minimum: 0, maximum: 1000 }'));
  assert.ok(mcp.includes('shadowBlur: { type: "number", minimum: 0, maximum: 200 }'));
  assert.ok(mcp.includes('"ux_direct_figma_canvas_write"'));
  assert.ok(mcp.includes('"ux_direct_figma_plugin_queue_health_check"'));
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
  assert.ok(plugin.includes('function findPageNode(id)'));
  assert.ok(plugin.includes('figma.currentPage.findOne(function (item) { return item.id === id; })'));
});

test("plugin UI dispatches only recognized command types and reports the result to the bridge", () => {
  assert.ok(pluginUi.includes('command.action === "read-canvas" || command.action === "write-canvas"'));
  assert.ok(pluginUi.includes('mode: "canvas-result"'));
  assert.ok(pluginUi.includes('operationError: message.error || undefined'));
});


test("canvas writer exposes native node, layout, style, component, selection, page, and export actions", () => {
  for (const action of [
    '"clone-node"', '"delete-node"', '"reorder-node"', '"reparent-node"', '"group-nodes"', '"ungroup-node"',
    '"set-current-page"',
    '"create-component"', '"create-instance"', '"detach-instance"', '"set-selection"',
    '"zoom-to-nodes"', '"create-page"', '"rename-page"', '"export-svg"', '"apply-style"',
  ]) {
    assert.ok(mcp.includes(action), "MCP schema missing " + action);
    assert.ok(bridge.includes(action), "Plugin bridge validation missing " + action);
  }
  for (const api of [
    'figma.createLine()', 'figma.createPolygon()', 'figma.createStar()', 'figma.createSlice()',
    'newParent.insertChild(insertAt, reparentTarget)', 'await figma.setCurrentPageAsync(targetPage)',
    'figma.group(groupNodes, groupParent)', 'figma.ungroup(ungroupTarget)',
    'figma.createComponentFromNode(componentSource)', 'componentSourceNode.createInstance()',
    'instanceTarget.detachInstance()', 'figma.currentPage.selection = selectionNodes',
    'figma.viewport.scrollAndZoomIntoView(zoomNodes)', 'await exportTarget.exportAsync({ format: "SVG_STRING" })',
    'figma.getLocalPaintStylesAsync()', 'figma.getLocalTextStylesAsync()',
  ]) {
    assert.ok(plugin.includes(api), "Native plugin executor missing " + api);
  }
  assert.ok(plugin.includes('svg.length > 35000'), "SVG output is capped to fit the bridge result envelope");
  assert.ok(mcp.includes('capabilities: { tools: { listChanged: false } }'), "MCP advertises tool-list change support");
  assert.ok(mcp.includes('enum: ["batch", "create-elements", "update-node"'), "Batch operation is part of the exposed write tool");
  assert.ok(mcp.includes('actions: {\n          type: "array", minItems: 1, maxItems: 40'), "MCP schema exposes sequential action batches");
  assert.ok(bridge.includes('value.operation === "batch" && value.actions && value.actions.some((step) => ["export-svg", "export-node", "create-image-fill"].includes(step.operation))'), "Bridge prevents large exports and inline image payloads in batches");
  assert.ok(plugin.includes('if (payload.operation === "batch")'), "Native executor supports ordered batches");
  assert.ok(plugin.includes('state: batchResults.length ? "partial" : "failed"'), "Batch result reports partial completion instead of claiming atomic success");
  assert.ok(plugin.includes('if (typeof spec.textCase === "string") node.textCase = spec.textCase'), "Text creation applies text case");
  assert.ok(plugin.includes('result = await readCanvasCommand(command.payload)'), "Async enriched reads must be awaited before posting bridge results");
  assert.ok(mcp.includes('queryName: { type: "string", minLength: 1, maxLength: 120'), "MCP read schema exposes node-name search");
  assert.ok(mcp.includes('includeStyles: { type: "boolean"'), "MCP read schema exposes local-style metadata");
  assert.ok(plugin.includes('scope = "search-current-page"'), "Native read supports current-page name/type filtering");
  assert.ok(plugin.includes('if (payload.operation === "flatten-nodes")'), "Native executor supports flatten");
  assert.ok(plugin.includes('if (payload.operation === "boolean-operation")'), "Native executor supports boolean operations");
  assert.ok(plugin.includes('figma.combineAsVariants(variantComponents, variantParent)'), "Native executor supports component variants");
  assert.ok(plugin.includes('if (payload.operation === "swap-component")'), "Native executor supports instance component swap");
  assert.ok(plugin.includes('if (payload.operation === "set-text-range")'), "Native executor supports text range typography");
  assert.ok(plugin.includes('if (payload.operation === "create-image-fill")'), "Native executor supports image fills");
  assert.ok(plugin.includes('if (payload.operation === "export-node")'), "Native executor supports PNG/PDF/SVG export");
  assert.ok(plugin.includes('if (payload.operation === "reparent-node")'), "Native executor supports layer reparenting");
  assert.ok(plugin.includes('if (payload.operation === "set-current-page")'), "Native executor supports switching to an approved page");
  assert.ok(plugin.includes('while (ancestor)'), "Reparent operation rejects parent/child cycles");
  assert.ok(mcp.includes('"flatten-nodes"') && mcp.includes('"boolean-operation"') && mcp.includes('"export-node"'), "MCP write schema exposes extended actions");
});
