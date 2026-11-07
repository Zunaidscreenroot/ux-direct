import test from "node:test";
import assert from "node:assert/strict";
import { coerceActionPlan, parseLooseJson } from "../src/figma-agent/coerce-action-plan";

const action = { operation: "set-effects", nodeId: "1:2", effects: [] };

test("near-miss planner replies become { summary, actions }", () => {
  assert.deepEqual(coerceActionPlan([action]), { summary: "Native Figma edit", actions: [action] });
  assert.deepEqual(coerceActionPlan({ ...action, summary: "Add shadow" }), { summary: "Add shadow", actions: [action] });
  assert.deepEqual(coerceActionPlan({ summary: "Wrap rows", steps: [action] }), { summary: "Wrap rows", actions: [action] });
  assert.deepEqual(coerceActionPlan({ result: { operations: [action] } }), { summary: "Native Figma edit", actions: [action] });
  assert.deepEqual(coerceActionPlan({ summary: "", actions: [action] }), { summary: "Native Figma edit", actions: [action] });
});

test("replies with no usable action are left as they are", () => {
  assert.deepEqual(coerceActionPlan({ summary: "I cannot do that" }), { summary: "I cannot do that" });
  assert.equal(coerceActionPlan(null), null);
  assert.deepEqual(coerceActionPlan([{ note: "x" }]), [{ note: "x" }]);
});

test("JSON inside prose or code fences is found", () => {
  assert.deepEqual(parseLooseJson("Here is the plan:\n```json\n{\"actions\":[{\"operation\":\"x\"}]}\n```\nDone."), { actions: [{ operation: "x" }] });
  assert.deepEqual(parseLooseJson("[{\"operation\":\"x\"}] trailing } text"), [{ operation: "x" }]);
  assert.equal(parseLooseJson("no json here"), null);
});
