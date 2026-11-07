import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filterKnowledge, pageParams, slicePage } from "../src/command-center/paging";

test("slicePage returns a small page and the next offset", () => {
  const items = Array.from({ length: 14 }, (_, index) => index);
  assert.deepEqual(slicePage(items, 0, 6), { items: [0, 1, 2, 3, 4, 5], total: 14, nextOffset: 6 });
  assert.deepEqual(slicePage(items, 12, 6), { items: [12, 13], total: 14, nextOffset: null });
  assert.deepEqual(pageParams(new URL("https://x/?offset=-3&limit=9999")), { offset: 0, limit: 50 });
  assert.deepEqual(pageParams(new URL("https://x/")), { offset: 0, limit: 6 });
});

test("filterKnowledge searches and filters server-side", () => {
  const entry = (title: string, category: string, roles: string[]) => ({ title, category, roles, tags: [], body: title + " body", sources: [] });
  const entries = [entry("Fitts law", "laws", ["all"]), entry("Contrast", "accessibility", ["ui-designer"])];
  assert.equal(filterKnowledge(entries, { search: "fitts" }).length, 1);
  assert.equal(filterKnowledge(entries, { role: "writer" }).length, 1);
  assert.equal(filterKnowledge(entries, { category: "accessibility" })[0].title, "Contrast");
});

test("command center pages load lazily and the knowledge base has no editing UI", () => {
  const page = readFileSync("app/chat/page.tsx", "utf8");
  for (const label of ["By model", "By agent role", "Free providers", "Recent calls"]) assert.ok(page.includes(label));
  assert.ok(page.includes('"view=models&tab=" + item'));
  assert.ok(page.includes("View more"));
  const kb = readFileSync("app/chat/knowledge-base.tsx", "utf8");
  assert.ok(kb.includes("View more"));
  for (const gone of ["Add entry", "startEdit", "<strong>Read-only", "Restore original", "method: \"POST\""]) assert.equal(kb.includes(gone), false, gone);
});
