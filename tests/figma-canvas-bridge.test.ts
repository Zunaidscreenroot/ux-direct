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
const actionAgent = read("app/api/assistant/figma-agent/actions/route.ts");
const planNormalizer = read("src/figma-agent/normalize-plan.ts");
const chatRoute = read("app/api/assistant/chat/route.ts");
const modelPolicy = read("src/providers/openrouter-models.ts");
const cockpitEffects = read("figma-plugin/ui-effects.tsx");

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
  assert.ok(plugin.includes('Math.min(5, Number.isInteger(payload.maxDepth)'));
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
  assert.ok(bridge.includes('value.operation === "batch" && value.actions && value.actions.some((step) => ["export-svg", "export-node", "create-image-fill", "insert-image"].includes(step.operation))'), "Bridge prevents large exports and inline image payloads in batches");
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
  assert.ok(agent.includes("const models = FIGMA_AGENT_MODELS.map((entry) => entry.id)"), "Figma generation must use Auto LOW followed by explicit cost-ordered fallbacks.");
  assert.equal(agent.includes("provider: ANTHROPIC_OPENROUTER_PROVIDER"), false, "No provider restrictions should be sent to OpenRouter.");
  assert.ok(modelPolicy.includes('"google/gemini-3.7-flash"'));
  assert.ok(modelPolicy.includes('"qwen/qwen3.5-35b-a3b"'));
  assert.ok(modelPolicy.includes('"google/gemini-3.1-flash-lite"'));
  assert.ok(modelPolicy.includes('"qwen/qwen3.5-397b-a17b"'));
  const generalModels = modelPolicy.slice(modelPolicy.indexOf("export const OPENROUTER_MODELS"), modelPolicy.indexOf("export const OPENROUTER_MODEL_LABELS"));
  assert.equal(generalModels.includes('"openrouter/auto"'), false);
  assert.ok(modelPolicy.includes("UX_DIRECT_DESIGN_ROLE"));
  assert.equal(modelPolicy.includes("only:"), false);
  assert.equal(modelPolicy.includes("allow_fallbacks"), false);
  assert.ok(agent.includes('response_format: { type: "json_object" }'), "The design agent must request structured output.");
  assert.ok(agent.includes('PlanSchema.safeParse('), "The provider plan must be schema-validated before canvas execution.");
  assert.ok(agent.includes('elements: z.array(ElementSchema).min(3).max(8)'), "Top-level design sections must be bounded without forcing filler groups.");
  assert.ok(agent.includes("Progress indicators must preserve their meaning"), "First-pass generation must preserve progress-ring semantics.");
  assert.ok(agent.includes("innerRadius about 0.68–0.8"), "Generation must support editable native progress arcs.");
  assert.ok(agent.includes("Top-level design sections must be named FRAME containers"), "Design plans must include semantic frame groups.");
  assert.ok(agent.includes("Only FRAME elements may contain nested children") || agent.includes("Only FRAME may contain nested children"), "Nested nodes must be valid native frame children.");
  assert.ok(agent.includes('No canvas changes were made.'), "Planning failures must not imply a canvas write.");
});

test("conversational cockpit executes, batches, selects, zooms and verifies native Figma designs", () => {
  assert.ok(pluginUi.includes('async function createFigmaDesign('));
  assert.ok(pluginUi.includes('runNativeCanvasCommand("read-canvas"'), "Design agent must inspect real layer contents first.");
  assert.ok(pluginUi.includes('"/api/assistant/figma-agent"'), "Design requests must call the structured planner.");
  assert.ok(pluginUi.includes('operation: "create-elements"'), "Design agent must write native nodes.");
  assert.ok(pluginUi.includes('batch.length < 20'), "Large sibling batches must stay within the bridge-safe limit.");
  assert.ok(pluginUi.includes("async function createPlanChildren(parentId, elements, depth)"), "Native designs must be constructed recursively from the nested frame hierarchy.");
  assert.ok(pluginUi.includes('operation: "set-selection"'), "The resulting variation should be selected.");
  assert.ok(pluginUi.includes('operation: "zoom-to-nodes"'), "The resulting variation should be brought into view.");
  assert.ok(pluginUi.includes('scope: "selection", maxDepth: 5, maxNodes: 100'), "Written frame hierarchy must be read back to full supported depth.");
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
  assert.ok(agent.includes("const models = FIGMA_AGENT_MODELS.map((entry) => entry.id)"), "Figma agent must try the shared Auto-first fallback chain sequentially.");
  assert.equal(agent.includes("provider: ANTHROPIC_OPENROUTER_PROVIDER"), false, "Model requests must not be provider filtered.");
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

test("normal conversational chat uses Gemini primary and cost-ordered explicit fallbacks", () => {
  assert.ok(chatRoute.includes("const ROUTER_MODEL = OPENROUTER_MODELS[0];"));
  assert.ok(chatRoute.includes("const FALLBACK_MODEL = OPENROUTER_MODELS[1];"));
  assert.equal(chatRoute.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false);
  assert.ok(chatRoute.includes("for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1)"));
  assert.ok(chatRoute.includes("openrouter/auto") === false, "Auto model slug is defined in shared model policy, not hard-coded in request routing.");
  assert.equal(chatRoute.includes("auto-router"), false);
});

test("Figma visual analysis uses a compact rendered JPEG and native layer data", () => {
  assert.ok(pluginUi.includes("async function captureRenderedNodePreview(nodeId)"));
  assert.ok(pluginUi.includes("const scales = [0.6, 0.45, 0.3, 0.2, 0.12, 0.08]"));
  assert.ok(pluginUi.includes('operation: "export-node"'));
  assert.ok(pluginUi.includes('format: "JPG"'));
  assert.ok(pluginUi.includes('data:image/jpeg;base64,'));
  assert.ok(pluginUi.includes('stage("error", "Source screenshot unavailable · design generation blocked")'));
  assert.ok(pluginUi.includes("will not create a variation without a rendered source screenshot"));
  assert.equal(pluginUi.includes('"Analysing native layers only · " + (visualCaptureWarning'), false,
    "Source screenshot failure must block generation instead of accepting layer-only output.");
  assert.ok(plugin.includes('exportOptions.constraint = { type: "SCALE"'));
  const writeSchema = bridge.slice(bridge.indexOf("const CANVAS_WRITE_PAYLOAD"), bridge.indexOf("type HealthReport"));
  assert.ok(writeSchema.includes('scale: z.number().finite().min(0.2).max(1).optional()'));
  assert.ok(agent.includes('renderedScreen: z.string().max(52000).nullable().optional()'));
  assert.ok(agent.includes('type: "image_url"'));
  assert.ok(agent.includes("Analyse BOTH the attached rendered screen image and native layer tree"));
});

test("native visual QA can trigger one bounded repair and a final re-check without browser automation", () => {
  const refine = read("app/api/assistant/figma-agent/refine/route.ts");
  const review = read("app/api/assistant/figma-agent/review/route.ts");
  assert.ok(pluginUi.includes("async function runVisualQualityLoop"));
  assert.ok(pluginUi.includes("/api/assistant/figma-agent/review"));
  assert.ok(pluginUi.includes("/api/assistant/figma-agent/refine"));
  assert.ok(pluginUi.includes("refinement.patch.slice(0, 12)"));
  assert.ok(pluginUi.includes('reviewCanvas(outputCanvas, capture.dataUrl || null, "after one bounded repair")'));
  assert.equal(pluginUi.includes("/api/assistant/figma-agent/live-qa"), false);
  assert.equal(pluginUi.includes("TinyFish"), false);
  assert.ok(refine.includes("FIGMA_AGENT_MODELS.map((entry) => entry.id)"));
  assert.ok(refine.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'));
  assert.ok(review.includes('type: "image_url"'));
  assert.ok(review.includes('sourceImage: z.string().max(52000).nullable().optional()'));
  assert.ok(review.includes('outputImage: z.string().max(52000).nullable().optional()'));
  assert.ok(review.includes("evaluateVisualQualityGate"));
  assert.ok(review.includes("hasSourceImage: !!sourceImage"));
  assert.ok(review.includes("hasOutputImage: !!outputImage"));
  assert.ok(refine.includes("PatchSchema"));
  assert.ok(refine.includes("found.get(entry.nodeId)"));
});
test("Figma plugin cockpit has a morphing orb and visible process stages", () => {
  assert.ok(pluginUi.includes('class="uxd-hero-orb"'));
  assert.ok(pluginUi.includes('id="processStatus"'));
  assert.ok(pluginUi.includes("function setProcessState"));
  for (const stage of ['"scanning"', '"capturing"', '"brain"', '"memory"', '"planning"', '"creating"', '"rendering"', '"reviewing"', '"verifying"', '"error"']) {
    assert.ok(pluginUi.includes(stage), "Missing process state " + stage);
  }
  const manifest = read("figma-plugin/manifest.json");
  assert.ok(manifest.includes("scaled PNG previews"));
});

test("Figma source visual capture failures block unverified design generation", () => {
  const reviewRoute = read("app/api/assistant/figma-agent/review/route.ts");
  const refinementRoute = read("app/api/assistant/figma-agent/refine/route.ts");
  assert.ok(reviewRoute.includes("extractJsonObject(message.content)"), "Visual QA must accept structured content variants.");
  assert.ok(reviewRoute.includes("normalizeVisualReview(decodedRecord)"), "Provider response fields must be normalized before strict QA validation.");
  assert.ok(refinementRoute.includes("extractJsonObject(message.content)"), "Refinement must parse structured content variants.");
  assert.ok(reviewRoute.includes("FIGMA_AGENT_MODELS.map((entry) => entry.id)"));
  assert.ok(reviewRoute.includes('plugins: [{ id: "auto-router", cost_tier: "low" }]'));
  assert.ok(refinementRoute.includes("FIGMA_AGENT_MODELS.map((entry) => entry.id)"));
  assert.equal(reviewRoute.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false);
  assert.equal(refinementRoute.includes("ANTHROPIC_OPENROUTER_PROVIDER"), false);
  assert.ok(agent.includes("renderedScreen: z.string().max(52000).nullable().optional()"));
  assert.ok(agent.includes('error: "Invalid Figma agent request."'));
  assert.ok(agent.includes('issue.path.join(".")'));
  assert.ok(reviewRoute.includes('sourceImage: z.string().max(52000).nullable().optional()'));
  assert.ok(reviewRoute.includes('outputImage: z.string().max(52000).nullable().optional()'));
  assert.ok(pluginUi.includes('detail.message || "Invalid input"'));
  assert.ok(pluginUi.includes('stage("error", "Source screenshot unavailable · design generation blocked")'));
  assert.ok(pluginUi.includes("will not create a variation without a rendered source screenshot"));
  assert.ok(reviewRoute.includes("evaluateVisualQualityGate"));
});

test("selected and generated frame screenshot export falls back to progressively smaller scales", () => {
  assert.ok(pluginUi.includes("const scales = [0.6, 0.45, 0.3, 0.2, 0.12, 0.08]"));
  assert.ok(pluginUi.includes("JPEG preview export failed at all attempted scales (60%, 45%, 30%, 20%, 12%, 8%)."));
  assert.ok(pluginUi.includes("const qualityTree = await runNativeCanvasCommand"));
  assert.ok(pluginUi.includes("outputCanvas: qualityTree"));
  assert.ok(pluginUi.includes("sourceImage: renderedScreen"));
});

test("native Figma design creation builds nested frame containers before their children", () => {
  assert.ok(pluginUi.includes("async function createPlanChildren(parentId, elements, depth)"));
  assert.ok(pluginUi.includes('target: "node", parentNodeId: parentId, elements: [spec]'));
  assert.ok(pluginUi.includes('target: "node", parentNodeId: parentId, elements: batch'));
  assert.ok(plugin.includes('target === "node"'));
  assert.ok(bridge.includes('target: z.enum(["current-page", "selection", "node", "test-lab"]).optional()'));
  assert.ok(pluginUi.includes("await createPlanChildren(container.id, children, depth + 1)"));
  assert.ok(pluginUi.includes("countPlanNodes(plan.elements)"));
  assert.ok(plugin.includes('node.type === "FRAME" && spec.noFill === true && "fills" in node'));
  assert.ok(bridge.includes("noFill: z.boolean().optional()"));
  assert.ok(agent.includes('children: z.array(ElementSchema).max(80).optional()'));
  assert.ok(agent.includes("Use a real Figma layer tree appropriate to selection scope"));
});

test("short Figma prompts inherit the complete design-variation workflow", () => {
  assert.ok(agent.includes("Users can give a short request. Infer the design procedure and execute the full playbook automatically"));
  assert.ok(agent.includes("preservation inventory from the selected layer tree"));
  assert.ok(agent.includes("Use actual native Figma Auto Layout"));
  assert.ok(agent.includes("layoutSizingHorizontal and layoutSizingVertical"));
  assert.ok(agent.includes("TARGET SCOPE: COMPONENT/CARD"));
  assert.ok(agent.includes("TARGET SCOPE: FULL SCREEN/FRAME"));
  assert.ok(agent.includes("designScope"));
  assert.ok(agent.includes("operatingContract"));
  assert.ok(pluginUi.includes("nativeCanvasCommandTail.then"));
  assert.ok(pluginUi.includes("runNativeCanvasCommandOnce"));
  assert.ok(pluginUi.includes("canvas action is already running"));
  assert.ok(pluginUi.includes('setProcessState("waiting"'));
  assert.ok(pluginUi.includes('waiting: "Waiting for the previous Figma action to finish"'));
});

test("native editor applies Auto Layout sizing and exposes image/variable operations safely", () => {
  assert.ok(plugin.includes("layoutSizingHorizontal"));
  assert.ok(plugin.includes("layoutSizingVertical"));
  assert.ok(plugin.includes("node[property] = value") || plugin.includes("targetNode[property] = value"));
  assert.ok(plugin.includes("x/y must not be assigned to normal Auto Layout children") || plugin.includes("if (!inAutoLayout || spec.layoutPositioning === \"ABSOLUTE\")"));
  assert.ok(plugin.includes('payload.operation === "insert-image"'));
  assert.ok(plugin.includes('payload.operation === "create-variables"'));
  assert.ok(plugin.includes('payload.operation === "bind-variable"'));
  assert.ok(plugin.includes("item.variableCollectionId === targetBindingCollection.id"));
  assert.ok(plugin.includes("payload.includeVariables === true"));
  assert.ok(agent.includes("variables: compactResourceList(canvas.variables, 120)"));
  assert.ok(actionAgent.includes("const invalidStyleAction = actions.find"));
  assert.ok(actionAgent.includes("const invalidVariableAction = actions.find"));
  assert.ok(actionAgent.includes("const rawStyles = isRecord(canvasRaw.styles) ? canvasRaw.styles : {}"));
  assert.ok(actionAgent.includes("variableCollections = Array.isArray(canvasRaw.variableCollections)"));
  assert.ok(agent.includes('paintStyleId: z.string().trim().min(1).max(300).optional()'));
  assert.ok(bridge.includes('"create-image-fill", "insert-image"].includes(step.operation)') || bridge.includes('"create-image-fill", "insert-image"].includes(step.operation)'));
});
 
test("Figma cockpit uses Libraries.dev Thinking Orbs for task-state updates", () => {
  assert.ok(cockpitEffects.includes('from "thinking-orbs"'));
  assert.ok(cockpitEffects.includes('state="searching"') || cockpitEffects.includes('state={state}'));
  for (const state of ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"]) {
    assert.ok(cockpitEffects.includes('"' + state + '"'), "Thinking orb state missing: " + state);
  }
  assert.ok(pluginUi.includes('id="uxdOrbRoot"'));
  assert.ok(pluginUi.includes('id="processOrbRoot"'));
  assert.ok(pluginUi.includes('<script src="ui-effects.js"></script>'));
  assert.equal(/uxd-orb-glow|uxd-orb-ring|uxd-orb-core|uxd-status-orbit/.test(pluginUi), false);
  assert.ok(pluginUi.includes("window.UXDEffects.setProcessState(state)"));
});

test("Libraries.dev Border Beam is wired to the composer focus and task lifecycle", () => {
  assert.ok(cockpitEffects.includes('from "border-beam"'));
  assert.ok(cockpitEffects.includes("<BorderBeam"));
  assert.ok(cockpitEffects.includes('colorVariant="ocean"'));
  assert.ok(cockpitEffects.includes('active={emphasis}'));
  assert.ok(pluginUi.includes('id="beamRoot"'));
  assert.ok(pluginUi.includes('setBeamEmphasis(true)'));
  assert.ok(pluginUi.includes('setBeamEmphasis(isSending)'));
  assert.ok(pluginUi.includes("activeTaskStates.includes(state)"));
  assert.equal(/uxd-orb-glow|uxd-orb-ring|uxd-orb-core|uxd-status-orbit/.test(pluginUi), false);
});


test("broad refinement routes through screenshot-aware design generation; precise layer commands use native edits", () => {
  assert.ok(pluginUi.includes("function isBroadDesignRequest") || pluginUi.includes("broadDesignIntent"), "The dispatcher must explicitly distinguish broad redesign requests.");
  assert.ok(pluginUi.includes("if (isDirectCanvasActionPrompt(prompt))"), "Precise native commands remain supported.");
  assert.ok(pluginUi.includes("if (isDesignActionPrompt(prompt))"), "Broad design requests keep the full generation flow.");
  assert.ok(pluginUi.includes("attachedImageData, visualCaptureWarning: visualCaptureWarning"), "Generation receives a separate user-attached visual reference.");
  assert.ok(pluginUi.includes("repairIteration: 1"), "A second repair is allowed only after the first repair still fails the QA gate.");
  assert.ok(pluginUi.includes("downloadNativeExport"), "Native export operations return a downloadable artifact.");
});

test("native action planner covers Figma page, export, boolean, flatten and image-fill APIs safely", () => {
  for (const operation of ["flatten-nodes", "boolean-operation", "create-page", "rename-page", "set-current-page", "export-svg", "export-node", "create-image-fill"]) {
    assert.ok(actionAgent.includes('"' + operation + '"'), "AI planner schema is missing " + operation);
    assert.ok(mcp.includes('"' + operation + '"'), "MCP exposes missing operation " + operation);
    assert.ok(bridge.includes('"' + operation + '"'), "Bridge is missing validation for " + operation);
    assert.ok(plugin.includes('payload.operation === "' + operation + '"'), "Native executor is missing " + operation);
  }
  assert.ok(actionAgent.includes("canvas.pages"), "Page switching must validate against the approved-file page catalogue.");
  assert.ok(actionAgent.includes("references a page ID outside the supplied approved-file page catalogue"));
  assert.ok(actionAgent.includes("no user-attached image was provided"), "A screenshot may not be misused as an image asset.");
  assert.ok(mcp.includes('"create-image-fill", "insert-image", "create-variables", "bind-variable"'), "MCP runtime permits the safe native image and token actions.");
  assert.ok(mcp.includes('["current-page", "selection", "node", "test-lab"].includes(String(input.target))'), "MCP and bridge agree on the node target.");
});


test("native visual edits cannot bypass final QA for leaf nodes or multiple roots", () => {
  const start = pluginUi.indexOf("async function executeNativeActionPlan");
  const end = pluginUi.indexOf("async function createFigmaDesign", start);
  assert.ok(start >= 0 && end > start, "Native action executor must be present.");
  const actionFlow = pluginUi.slice(start, end);
  assert.ok(actionFlow.includes("if (hasVisualMutations)"));
  assert.equal(actionFlow.includes("if (hasVisualMutations && canvas.nodes.length === 1 && Array.isArray(root.children))"), false);
  assert.ok(actionFlow.includes("if (canvas.nodes.length !== 1)"));
  assert.ok(actionFlow.includes("if (!qa || qa.passed !== true)"));
  assert.ok(actionFlow.includes('"apply-style", "bind-variable"'));
  assert.ok(actionFlow.includes('"opacity", "visible", "rotation"'));
});


test("visual QA exits without model calls when rendered evidence is missing", () => {
  const start = pluginUi.indexOf("async function runVisualQualityLoop");
  const end = pluginUi.indexOf("function downloadNativeExport", start);
  assert.ok(start >= 0 && end > start, "Visual quality loop must be present.");
  const qualityLoop = pluginUi.slice(start, end);
  assert.ok(qualityLoop.includes("if (!sourceImage)"));
  assert.ok(qualityLoop.includes("if (!capture || !capture.dataUrl)"));
  assert.ok(qualityLoop.includes("Visual QA blocked because the repaired output screenshot could not be captured"));
});
