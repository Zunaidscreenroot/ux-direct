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

test("native health check preserves strict file scope and intentionally skips Team Library", () => {
  assert.ok(pluginSource.includes('assertUxDirectFileScope("starting native API health check")'));
  assert.ok(pluginSource.includes('add("Library", "Team Library", "not-tested", "not-tested"'));
  assert.ok(pluginSource.includes("Not tested intentionally: team-library APIs are out of scope"));
});

test("native health check does not emit a separate telemetry request for each check", () => {
  assert.ok(pluginSource.includes('figma.ui.postMessage(Object.assign({}, report, { commandId: id || null }))'));
  assert.doesNotMatch(pluginSource, /sendTelemetry\(["']Plugin API check:/);
});
