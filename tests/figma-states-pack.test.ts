/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin UI code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");

function classifier(): (prompt: string, ctx: any) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = classifyQuickTask;", sandbox);
  return (prompt, ctx) => { const out = sandbox.fn(prompt, ctx); return out === null ? null : JSON.parse(JSON.stringify(out)); };
}

test("state requests on one screen become a states pack", () => {
  const classify = classifier();
  const frame = { selectionTypes: ["FRAME"] };
  assert.deepEqual(classify("add empty, loading and error states", frame), { kind: "states-pack", states: ["empty", "loading", "error"] });
  assert.deepEqual(classify("create the states for this screen", frame).states, ["empty", "loading", "error"]);
  assert.deepEqual(classify("design the error state", frame).states, ["error"]);
  assert.deepEqual(classify("error screen bana do", frame).states, ["error"]);
  assert.deepEqual(classify("make a skeleton loading screen", frame).states, ["loading"]);
  assert.deepEqual(classify("add empty and success states", frame).states, ["empty", "success"]);
  // Not states: keep existing paths.
  assert.equal(classify("improve this screen", frame), null);
  assert.equal(classify("make 3 variations of this screen", frame).kind, "screen-variations");
  assert.notEqual(classify("add empty state", { selectionTypes: ["FRAME", "FRAME"] })?.kind, "states-pack", "one screen at a time");
  assert.notEqual(classify("fix the error text", { selectionTypes: ["TEXT"] })?.kind, "states-pack");
});

test("the state is sent to the planner and to structural lint, and only when set", () => {
  assert.match(ui, /\.\.\.\(designOptions && designOptions\.state \? \{ state: designOptions\.state \} : \{\}\)/);
  assert.match(ui, /\.\.\.\(options\.state \? \{ state: options\.state \} : \{\}\) \};/);
  assert.match(ui, /state: designOptions && designOptions\.state \? designOptions\.state : undefined/);
  assert.match(ui, /sourceId: job\.frame\.id, state: job\.state \}/);
  assert.match(ui, /task\.kind === "states-pack"\) return runVariationsTask/);
});

test("batch jobs reserve one free row and keep exact slots and consistent names", () => {
  const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
  assert.match(ui, /if \(!\(placement && designOptions\.exactPlacement\)\)/, "exact slots skip the per-job free-spot search");
  assert.match(ui, /const slot = await batchRow\(frame, task\.states\.length\)/);
  assert.match(ui, /frameName: String\(frame\.name\)\.slice\(0, 60\) \+ " \/ "/, "state frames are named <screen> / <State> by the plugin, not the model");
  assert.match(ui, /\.\.\.\(createMode \? \{ mode: "create" \} : \{\}\)/, "an empty selection asks the backend for a new screen");
});
