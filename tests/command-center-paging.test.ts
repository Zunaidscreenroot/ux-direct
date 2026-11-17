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
  // The knowledge corpus itself is still read-only here: no adding, editing or restoring entries.
  for (const gone of ["Add entry", "startEdit", "<strong>Read-only", "Restore original"]) assert.equal(kb.includes(gone), false, gone);
});

test("the knowledge base can approve drafts, and says why each one was proposed", () => {
  const kb = readFileSync("app/chat/knowledge-base.tsx", "utf8");
  // Deciding on a draft is the one write this page has, and it is deliberate: a rule that
  // cleared the relevance gate is not used until someone approves it.
  assert.ok(kb.includes('action: "review"'));
  for (const label of ["Approve", "Reject", "Archive"]) assert.ok(kb.includes(label), label);
  // A decision needs the reasoning, not just the title.
  for (const shown of ["Why: ", "What was seen", "Reason for the decision"]) assert.ok(kb.includes(shown), shown);
  // Three views, and Studio's branch is named so it is clear what it reads.
  for (const tab of ["UX knowledge", "A11y Studio", "Approvals"]) assert.ok(kb.includes(tab), tab);
  assert.ok(kb.includes("project:ux-audit"));

  const route = readFileSync("app/api/command-center/knowledge/route.ts", "utf8");
  for (const view of ['view") === "studio"', 'view") === "approvals"']) assert.ok(route.includes(view), view);
  assert.ok(route.includes("reviewBrainFeedback"));
  // Approvals must not sit behind the dormant corpus edit lock, or none could ever be made.
  assert.ok(route.indexOf("asReview") < route.indexOf("knowledgeEditState(request)"));
});
