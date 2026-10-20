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
const agent = read("app/api/assistant/figma-agent/route.ts");
const planNormalizer = read("src/figma-agent/normalize-plan.ts");
const chatRoute = read("app/api/assistant/chat/route.ts");

test("conversational cockpit inline JavaScript parses successfully", () => {
  const match = pluginUi.match(/<script>([\s\S]*?)<\/script>/i);
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

test("in-Figma design agent retrieves approved brain context and validates native layer plans", () => {
  assert.ok(agent.includes('retrieveBrainContext('), "Figma design planning must retrieve shared memory.");
  assert.ok(agent.includes('resolveBrainScopes('), "Brain retrieval must be scope-filtered.");
  assert.ok(agent.includes('const models = ["openai/gpt-6-luna", "openrouter/auto"];'), "GPT-6 Luna must be primary and OpenRouter Auto fallback.");
  assert.ok(agent.includes('response_format: { type: "json_object" }'), "The design agent must request structured output.");
  assert.ok(agent.includes('PlanSchema.safeParse('), "The provider plan must be schema-validated before canvas execution.");
  assert.ok(agent.includes('elements: z.array(ElementSchema).min(5).max(80)'), "Native element count must be bounded.");
  assert.ok(agent.includes('No canvas changes were made.'), "Planning failures must not imply a canvas write.");
});

test("conversational cockpit executes, batches, selects, zooms and verifies native Figma designs", () => {
  assert.ok(pluginUi.includes('async function createFigmaDesign('));
  assert.ok(pluginUi.includes('runNativeCanvasCommand("read-canvas"'), "Design agent must inspect real layer contents first.");
  assert.ok(pluginUi.includes('"/api/assistant/figma-agent"'), "Design requests must call the structured planner.");
  assert.ok(pluginUi.includes('operation: "create-elements"'), "Design agent must write native nodes.");
  assert.ok(pluginUi.includes('start += 20'), "Large native layouts must be chunked into bridge-safe writes.");
  assert.ok(pluginUi.includes('operation: "set-selection"'), "The resulting variation should be selected.");
  assert.ok(pluginUi.includes('operation: "zoom-to-nodes"'), "The resulting variation should be brought into view.");
  assert.ok(pluginUi.includes('scope: "selection", maxDepth: 2, maxNodes: 100'), "Written design must be read back.");
  assert.ok(pluginUi.includes('verifiedNode.childCount'), "Success must require a verification result.");
});

test("native plugin bridge accepts in-plugin commands only with the live allowlisted session token", () => {
  assert.ok(bridge.includes('mode === "plugin-command"'));
  assert.ok(bridge.includes('current.sessionToken !== token.data'));
  assert.ok(bridge.includes('current.fileKey !== body.fileKey'));
  assert.ok(bridge.includes('current.status !== "online"'));
  assert.ok(bridge.includes('CANVAS_WRITE_PAYLOAD.safeParse(body.payload)'));
  assert.ok(bridge.includes('expiresAt: new Date(now.getTime() + 240000).toISOString()'));
});

test("Figma agent normalizes provider-native design fields and uses the requested model order", () => {
  assert.ok(agent.includes('import { normalizePlan } from "@/src/figma-agent/normalize-plan";'), "The design route must normalize provider output before strict schema validation.");
  assert.ok(planNormalizer.includes("export function normalizePlan("), "The reusable normalizer must be directly testable.");
  assert.ok(planNormalizer.includes("item.fill ?? item.backgroundColor"), "Provider fill aliases must map to the native Figma color field.");
  assert.ok(planNormalizer.includes("item.kind ?? item.elementType ?? item.nodeType"), "Provider layer type aliases must be normalized.");
  assert.ok(agent.includes("const models = [\"openai/gpt-6-luna\", \"openrouter/auto\"];"), "GPT-6 Luna must be primary and OpenRouter Auto fallback.");
  assert.ok(agent.includes("const normalizedPlan = normalizePlan(rawPlan, canvas);"), "A normalized model plan must be validated before any canvas write.");
  assert.ok(agent.includes('PlanSchema.safeParse(normalizedPlan)'), "Native plan schema validation must remain mandatory.");
});

test("connection panel exposes an expandable native Figma health-check report", () => {
  assert.ok(pluginUi.includes('id="healthSummary"'), "Connection details must expose a clickable health-check label.");
  assert.ok(pluginUi.includes('id="healthDetails"'), "Health-check label must expand a native action inventory.");
  assert.ok(pluginUi.includes('id="healthCheckList"'), "All checks must be rendered in the detailed list.");
  assert.ok(pluginUi.includes("function visibleHealthChecks(report)"), "Folder, file, and library access must be filtered from the user-facing list.");
  assert.ok(pluginUi.includes('mode: "health-state"'), "The panel should load the last saved report for this plugin session.");
  assert.ok(pluginUi.includes('type: "run-native-health-check"'), "The user can explicitly run or rerun the native checks.");
});

test("native health check catalogue includes more than 100 non-file API probes and all native writer actions", () => {
  const start = plugin.indexOf("var nativeCapabilityProbes = [");
  const end = plugin.indexOf("nativeCapabilityProbes.forEach", start);
  assert.ok(start >= 0 && end > start, "Native capability inventory must exist.");
  const catalogue = plugin.slice(start, end);
  const probeCount = (catalogue.match(/\["[^"]+",\s*"[^"]+",\s*function/g) || []).length;
  assert.ok(probeCount >= 100, "Expected 100+ API capability probes, got " + probeCount);
  assert.doesNotMatch(catalogue, /\["[^"]+",\s*"[^"]*(?:folder|file access|team library)[^"]*"/i, "Folder/file access must not be part of the capability catalogue.");
  for (const operation of [
    "batch", "create-elements", "update-node", "clone-node", "delete-node", "reorder-node",
    "reparent-node", "group-nodes", "ungroup-node", "flatten-nodes", "boolean-operation",
    "create-component", "create-component-set", "create-instance", "swap-component", "detach-instance",
    "set-selection", "zoom-to-nodes", "create-page", "rename-page", "set-current-page",
    "export-svg", "export-node", "apply-style", "set-text-range", "create-image-fill",
  ]) assert.ok(plugin.includes('"' + operation + '"'), "Missing native operation in health inventory: " + operation);
});

test("bridge supports saved health reports above the legacy 100-check ceiling", () => {
  assert.ok(bridge.includes("checks: z.array(CHECK).max(300)"));
  assert.ok(bridge.includes('mode === "health-state"'));
});

test("normal conversational chat prefers GPT-6 Luna and only starts Auto after primary failure", () => {
  assert.ok(chatRoute.includes('const ROUTER_MODEL = "openai/gpt-6-luna";'));
  assert.ok(chatRoute.includes('const FALLBACK_MODEL = "openrouter/auto";'));
  assert.ok(chatRoute.includes("Sequential fallback avoids starting or charging a second inference unless the primary fails."));
  assert.ok(chatRoute.includes("const fallback = startAttempt(FALLBACK_MODEL);"));
  assert.ok(chatRoute.includes('currentModel === FALLBACK_MODEL ? { plugins: [{ id: "auto-router", cost_tier: "low" }] }'));
});

test("Figma visual analysis receives a scaled rendered PNG together with native layer data", () => {
  assert.ok(pluginUi.includes('operation: "export-node", nodeId: sourceNode.id, format: "PNG", scale: 0.35'));
  assert.ok(plugin.includes('exportOptions.constraint = { type: "SCALE"'));
  assert.ok(bridge.includes('scale: z.number().finite().min(0.2).max(1).optional()'));
  assert.ok(agent.includes('renderedScreen: z.string().max(52000).optional()'));
  assert.ok(agent.includes('type: "image_url"'));
  assert.ok(agent.includes("Analyse BOTH the attached rendered screen image and native layer tree"));
});

test("Figma visual review and refinement endpoints are wired and bounded", () => {
  const review = read("app/api/assistant/figma-agent/review/route.ts");
  const refine = read("app/api/assistant/figma-agent/refine/route.ts");
  assert.ok(pluginUi.includes("/api/assistant/figma-agent/review"));
  assert.ok(pluginUi.includes("/api/assistant/figma-agent/refine"));
  assert.ok(pluginUi.includes("iteration <= 3"));
  assert.ok(pluginUi.includes("iteration === 3"));
  assert.ok(review.includes('type: "image_url"'));
  assert.ok(review.includes("visualInspection: !!sourceImage && !!outputImage"));
  assert.ok(refine.includes("PatchSchema"));
  assert.ok(refine.includes("found.get(entry.nodeId)"));
  assert.ok(pluginUi.includes("allowedIds.has(item.nodeId)"));
});

test("Figma plugin cockpit has a morphing orb and visible process stages", () => {
  assert.ok(pluginUi.includes('class="uxd-hero-orb"'));
  assert.ok(pluginUi.includes('id="processStatus"'));
  assert.ok(pluginUi.includes("function setProcessState"));
  for (const stage of ['"scanning"', '"capturing"', '"brain"', '"memory"', '"planning"', '"creating"', '"rendering"', '"reviewing"', '"refining"', '"verifying"', '"error"']) {
    assert.ok(pluginUi.includes(stage), "Missing process state " + stage);
  }
  const manifest = read("figma-plugin/manifest.json");
  assert.ok(manifest.includes("scaled PNG previews"));
});
