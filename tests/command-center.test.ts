import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatActivityForPrompt, normalizeActivityRow, summarizeActivity } from "../src/command-center/activity";
import { buildCommandCenterPrompt, COMMAND_CENTER_REFUSAL } from "../src/command-center/chat-scope";
import { isCommandCenterAuthorized } from "../src/command-center/access";
import { normalizeRule } from "../src/command-center/knowledge";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("activity rows normalize, summarize by outcome/day and format into a bounded prompt log", () => {
  const items = [
    normalizeActivityRow({ id: "a", updated_at: "2026-11-06T10:00:00Z", title: "Improve login screen", request_summary: "make it cleaner", outcome: "verified", duration_ms: 42000, metadata: { model: "glm-5" } }),
    normalizeActivityRow({ id: "b", updated_at: "2026-11-05T09:00:00Z", title: "Variations", outcome: "failed", error_summary: "lint failed" }),
    normalizeActivityRow({ id: "c", updated_at: "2026-11-05T08:00:00Z", outcome: "weird" }),
  ];
  assert.equal(items[0].model, "glm-5");
  assert.equal(items[2].outcome, "unknown");
  assert.equal(items[2].title, "Untitled plugin task");
  const summary = summarizeActivity(items);
  assert.equal(summary.total, 3);
  assert.equal(summary.byOutcome.verified, 1);
  assert.equal(summary.byOutcome.failed, 1);
  assert.deepEqual(summary.byDay, [{ day: "2026-11-06", count: 1 }, { day: "2026-11-05", count: 2 }]);
  const log = formatActivityForPrompt(items);
  assert.ok(log.includes("2026-11-06 10:00 UTC | verified | Improve login screen"));
  assert.ok(log.includes("error: lint failed"));
  assert.ok(formatActivityForPrompt(items, 80).split("\n").length < 3);
});

test("command-center prompt forbids general knowledge and states missing activity honestly", () => {
  const prompt = buildCommandCenterPrompt("- run", "complete");
  assert.ok(prompt.includes("Never use general, universal or world knowledge"));
  assert.ok(prompt.includes(COMMAND_CENTER_REFUSAL));
  assert.ok(prompt.includes("PLUGIN_ACTIVITY (last 7 days"));
  assert.ok(buildCommandCenterPrompt("", "empty").includes("no plugin runs were recorded"));
  assert.ok(buildCommandCenterPrompt("", "degraded").includes("unavailable"));
});

test("command-center is open without a key, and locked by a 16+ char key when one is set", () => {
  const previous = process.env.UX_DIRECT_COMMAND_CENTER_KEY;
  try {
    delete process.env.UX_DIRECT_COMMAND_CENTER_KEY;
    assert.equal(isCommandCenterAuthorized(new Request("https://x.test/api/command-center")), true);
    process.env.UX_DIRECT_COMMAND_CENTER_KEY = "short";
    assert.equal(isCommandCenterAuthorized(new Request("https://x.test", { headers: { "x-uxd-command-key": "short" } })), false);
    process.env.UX_DIRECT_COMMAND_CENTER_KEY = "a-very-long-owner-key-123";
    assert.equal(isCommandCenterAuthorized(new Request("https://x.test", { headers: { "x-uxd-command-key": "wrong-key-wrong-key-12" } })), false);
    assert.equal(isCommandCenterAuthorized(new Request("https://x.test", { headers: { "x-uxd-command-key": "a-very-long-owner-key-123" } })), true);
  } finally {
    if (previous === undefined) delete process.env.UX_DIRECT_COMMAND_CENTER_KEY; else process.env.UX_DIRECT_COMMAND_CENTER_KEY = previous;
  }
});

test("knowledge view shows the distilled rule, never the raw owner feedback", () => {
  const rule = normalizeRule({ id: "r", title: "Keep icons", normalized_rule: "Preserve source icons.", raw_feedback: "secret raw words", scope_key: "project:ux-direct" });
  assert.equal(rule.rule, "Preserve source icons.");
  assert.equal(JSON.stringify(rule).includes("secret raw words"), false);
});

test("chat route gates command-center mode, skips brain writes there, and keeps plugin chat unchanged", () => {
  const route = read("app/api/assistant/chat/route.ts");
  assert.ok(route.includes('value.mode === "command-center"'));
  assert.ok(route.includes("isCommandCenterAuthorized(request)"));
  assert.ok(route.includes("Command-center chat is only available in the UX Direct dashboard."));
  assert.ok(route.includes("buildCommandCenterPrompt(activity.text, activity.status)"));
  assert.ok(route.includes("commandCenter ? Promise.resolve<ChatLearningCapture>({ status: \"none\" })"));
  const api = read("app/api/command-center/route.ts");
  assert.ok(api.includes("isCommandCenterAuthorized(request)"));
});
