import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/tasks/plan/route";

test("task planning endpoint returns a zero-cost plan for a valid DMI task", async () => {
  const request = new Request("http://localhost/api/tasks/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "DMI VKYC journey",
      request: "Plan VKYC with consent, retry and failure states",
      project: "dmi-finance",
    }),
  });

  const response = await POST(request);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, "mock");
  assert.deepEqual(body.cost, { currency: "INR", amount: 0 });
  assert.equal(body.task.project, "dmi-finance");
  assert.equal(body.plan.requiresHumanReview, true);
  assert.ok(body.plan.steps.length >= 4);
});

test("task planning endpoint rejects invalid project and short request", async () => {
  const request = new Request("http://localhost/api/tasks/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Invalid task",
      request: "no",
      project: "unknown-project",
    }),
  });

  const response = await POST(request);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "Invalid task input");
});

test("task planning endpoint handles malformed JSON without crashing", async () => {
  const request = new Request("http://localhost/api/tasks/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });

  const response = await POST(request);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, "Could not create task plan");
});
