import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginSource = readFileSync(resolve(process.cwd(), "figma-plugin/code.js"), "utf8");

test("native health-check source includes all six new functional Figma actions", () => {
  const required = [
    'await runTest("Node actions", "Clone node and verify properties"',
    'await runTest("Layout and styling", "Apply frame auto layout"',
    'await runTest("Layout and styling", "Rotate node and set constraints"',
    'await runTest("Text", "Set and verify text range font size"',
    'await runTest("Export", "Export shape to SVG"',
    'await runTest("Layout and styling", "Reorder nodes with insertChild"',
  ];
  for (const check of required) assert.ok(pluginSource.includes(check), `Missing Figma action check: ${check}`);
});

test("SVG export uses the native SVG_STRING result without TextDecoder", () => {
  assert.ok(pluginSource.includes('node.exportAsync({ format: "SVG_STRING" })'));
  assert.equal(pluginSource.includes("new TextDecoder"), false);
});

test("component discovery uses supported node criteria rather than nonexistent global APIs", () => {
  assert.ok(pluginSource.includes('harness.findAllWithCriteria({ types: ["COMPONENT"] })'));
  assert.ok(pluginSource.includes('harness.findAllWithCriteria({ types: ["COMPONENT_SET"] })'));
  assert.doesNotMatch(pluginSource, /figma[.]getLocalComponentsAsync|figma[.]getLocalComponentSetsAsync/);
});

test("remaining safe availability APIs are executed as functional tests", () => {
  const functionalApis = [
    'await runTest("Styles", "figma.getLocalPaintStylesAsync"',
    'await runTest("Styles", "figma.getLocalTextStylesAsync"',
    'await runTest("Styles", "figma.getLocalEffectStylesAsync"',
    'await runTest("Styles", "figma.getLocalGridStylesAsync"',
    'await runTest("Styles", "figma.getStyleByIdAsync"',
    'await runTest("Document loading", "figma.loadAllPagesAsync"',
    'await runTest("Image API", "figma.createImage"',
    'await runTest("Slice API", "figma.createSlice"',
    'await runTest("Undo API", "figma.triggerUndo"',
    'await runTest("Plugin UI", "figma.ui.resize"',
    'await runTest("Variables", "figma.variables.getVariableCollectionByIdAsync"',
  ];
  for (const api of functionalApis) assert.ok(pluginSource.includes(api), `Expected a functional test for ${api}`);
  assert.ok(pluginSource.includes("image.getBytesAsync()"), "Image test reads the created resource back");
  assert.ok(pluginSource.includes("figma.commitUndo()"), "Undo test establishes an isolated checkpoint");
  assert.ok(pluginSource.includes("getLocalPaintStylesAsync"), "Style tests verify results from local style reads");
});

test("closePlugin/openExternal are not tested, while notify and UI on/off remain availability-only", () => {
  assert.ok(pluginSource.includes('add("Plugin lifecycle", "figma.closePlugin", "not-tested", "not-tested"'));
  assert.ok(pluginSource.includes('add("External navigation", "figma.openExternal", "not-tested", "not-tested"'));
  assert.ok(pluginSource.includes('availability("Notifications", "figma.notify"'));
  assert.ok(pluginSource.includes('availability("Plugin UI", "figma.ui.on"'));
  assert.ok(pluginSource.includes('availability("Plugin UI", "figma.ui.off"'));
  assert.equal(pluginSource.includes('await runTest("Plugin UI", "figma.ui.on"'), false);
  assert.equal(pluginSource.includes('await runTest("Plugin UI", "figma.ui.off"'), false);
  assert.equal(pluginSource.includes('await runTest("Notifications", "figma.notify"'), false);
});

test("selectionchange is intentionally not-tested on inactive Test Lab to preserve the user's active page", () => {
  assert.ok(pluginSource.includes('add("Events", "Receive selection-change event from inactive page", "not-tested", "not-tested"'));
  assert.ok(pluginSource.includes("selectionchange is tied to the current page"));
  assert.ok(pluginSource.includes("Testing the UXD API Test Lab page in the background would require switching away"));
});

test("figma.off is availability-only and native health checks never navigate away from the active page", () => {
  assert.ok(pluginSource.includes('availability("Events", "Register/remove listener with figma.off"'));
  assert.ok(pluginSource.includes('typeof figma.off === "function"'));
  assert.equal(pluginSource.includes('await runTest("Events", "Register/remove listener with figma.off"'), false);
  assert.equal(pluginSource.includes("withActiveTestLabPage"), false);
  const healthCheckSource = pluginSource.slice(pluginSource.indexOf("async function executeNativeApiHealthCheck"), pluginSource.indexOf("async function runNativeApiHealthCheck"));
  assert.equal(healthCheckSource.includes("await figma.setCurrentPageAsync"), false);
});

test("native health check preserves strict file scope and intentionally skips Team Library", () => {
  assert.ok(pluginSource.includes('assertUxDirectFileScope("starting native API health check")'));
  assert.ok(pluginSource.includes('add("Library", "Team Library", "not-tested", "not-tested"'));
  assert.ok(pluginSource.includes("Not tested intentionally: team-library APIs are out of scope"));
});

test("native health check does not emit a separate telemetry request for each check", () => {
  assert.ok(pluginSource.includes('figma.ui.postMessage(Object.assign({}, report, { commandId: id || null }))'));
  assert.doesNotMatch(pluginSource, /sendTelemetry\(["']Plugin API check:/);
});
