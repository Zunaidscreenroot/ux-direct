import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrainScopes, buildRetrievalQuery } from "../src/memory/chat-context";

test("general UX learning scope is included for later chat retrieval", () => {
  const scopes = resolveBrainScopes("Create a responsive component flow");
  assert.ok(scopes.includes("UX_SHARED_BRAIN"));
  assert.ok(scopes.includes("project:general-ux"));
  assert.ok(scopes.includes("project:ux-direct"));
});

test("named-client scopes are added without replacing reusable general UX memory", () => {
  const scopes = resolveBrainScopes("Improve Ujjivan SFB website navigation");
  assert.ok(scopes.includes("project:general-ux"));
  assert.ok(scopes.includes("project:ujjivan-sfb"));
  assert.ok(!scopes.includes("project:dmi-finance"));
});

test("short follow-ups retain task context for scope-safe memory lookup", () => {
  const query = buildRetrievalQuery("fix this", "Ujjivan SFB website navigation");
  assert.match(query, /Ujjivan SFB website navigation/);
  assert.match(query, /fix this/);
});
