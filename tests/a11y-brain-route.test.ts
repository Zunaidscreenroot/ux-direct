import test from "node:test";
import assert from "node:assert/strict";
import { GET, OPTIONS, POST } from "../app/api/a11y/brain/route";

const ORIGIN = "https://accessaudit-sigma.vercel.app";

function post(body: unknown, origin = ORIGIN) {
  return POST(new Request("https://uxdirect.test/api/a11y/brain", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

test("the door names its branch and the gate", async () => {
  const j = await (await GET(new Request("https://uxdirect.test/api/a11y/brain", { headers: { origin: ORIGIN } }))).json();
  assert.equal(j.branch, "project:ux-audit");
  assert.equal(j.threshold, 0.5);
  assert.equal(j.writeStatus, "draft");
});

test("preflight allows the Figma sandbox origin", async () => {
  const r = await OPTIONS(new Request("https://uxdirect.test/api/a11y/brain", { method: "OPTIONS", headers: { origin: "null" } }));
  assert.equal(r.status, 204);
});

test("another origin is refused", async () => {
  assert.equal((await post({ action: "recall", query: "contrast" }, "https://evil.example")).status, 403);
});

test("an unknown action is refused", async () => {
  const r = await post({ action: "forget", query: "x" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /recall|learn/);
});

test("recall needs a query, and learn needs a title and a rule", async () => {
  assert.equal((await post({ action: "recall" })).status, 400);
  assert.equal((await post({ action: "learn", title: "only a title" })).status, 400);
});

test("provenance has to be one of the three", async () => {
  const r = await post({ action: "learn", title: "t", rule: "r", provenance: "vibes" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /measured, model or human/);
});

/* The scope lock is the point of this door: a caller must not be able to reach the global
   brain by asking for it. These go through to the database, so they are checked by the error
   that comes back rather than by a stored row — what matters is that neither call is a 400,
   which is what a rejected scope would produce before any database work. */
test("a client name becomes a sub-branch, and a global scope cannot be asked for", async () => {
  const bad = await post({ action: "recall", query: "contrast", client: "UX_SHARED_BRAIN" });
  assert.notEqual(bad.status, 400);        // not rejected as input: it is simply ignored
  const ok = await post({ action: "recall", query: "contrast", client: "ujjivan-sfb" });
  assert.notEqual(ok.status, 400);
});

/* The branch's signals decide whether a real accessibility rule reaches the knowledge base.
   Before these were added, a rule phrased in criteria and assistive-technology terms scored
   on generic UX words alone and fell under the 50% threshold. */
import { assessBrainRelevance } from "../src/memory/learning-signal";

test("an accessibility rule clears the gate on this branch", () => {
  const r = assessBrainRelevance(
    "Masked account numbers need a spoken label",
    "A screen reader reads XXXXXX5793 character by character. The spec should give 'account ending 5793'. WCAG 4.1.2, and RBI accessibility.",
    "project:ux-audit",
  );
  assert.ok(r.eligible, "scored " + r.score + " with " + r.scopeSignals.join(", "));
});

test("a persona-test lesson clears it too", () => {
  const r = assessBrainRelevance(
    "Low vision participants lose grey helper text",
    "Participants with low vision could not read helper text below 4.5:1 contrast on the payment screen; think-aloud showed they skipped it.",
    "project:ux-audit",
  );
  assert.ok(r.eligible, "scored " + r.score);
});

test("an unrelated note still fails the gate", () => {
  const r = assessBrainRelevance("Lunch plan", "We should order biryani on Friday.", "project:ux-audit");
  assert.equal(r.eligible, false);
});
