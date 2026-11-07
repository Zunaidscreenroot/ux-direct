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

test("action-plan schema drift: alias keys are normalised before strict validation", () => {
  const plan = coerceActionPlan({ summary: "Increase card gap", actions: [
    { action: "update_node", node_id: "1:2", properties: { itemSpacing: 16 }, reason: "more air" },
    { op: "updateNode", id: "1:3", patch: { visible: false }, description: "hide" },
    { type: "hide-node", nodeId: "1:4" },
    { operation: "set-opacity", nodeId: "1:5", opacity: 0.5, action: "set-opacity" },
    { command: "rename", nodeId: "1:6", name: "Loans tab" },
    { operation: "set-gap", nodeId: "1:7", gap: 16 },
  ] }) as { actions: Array<Record<string, unknown>> };
  assert.deepEqual(plan.actions, [
    { operation: "update-node", nodeId: "1:2", patch: { itemSpacing: 16 } },
    { operation: "update-node", nodeId: "1:3", patch: { visible: false } },
    { operation: "update-node", nodeId: "1:4", patch: { visible: false } },
    { operation: "update-node", nodeId: "1:5", patch: { opacity: 0.5 } },
    { operation: "update-node", nodeId: "1:6", patch: { name: "Loans tab" } },
    { operation: "update-node", nodeId: "1:7", patch: { itemSpacing: 16 } },
  ]);
  // Real operations and their own fields are left alone.
  const page = coerceActionPlan({ operation: "create-page", name: "Loans" }) as { actions: unknown[] };
  assert.deepEqual(page.actions, [{ operation: "create-page", name: "Loans" }]);
});
