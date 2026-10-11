import test from "node:test";
import assert from "node:assert/strict";
import { ProjectMemory } from "../src/memory/project-memory";

const entry = {
  id: "express-pattern-1",
  project: "express-computers" as const,
  kind: "pattern" as const,
  title: "Table filter pattern",
  detail: "Use the approved compact filter row and preserve the existing spacing.",
  source: "Batch 2 screen node 44",
  verified: true,
  tags: ["Table", "FILTER"],
  createdAt: "2026-10-11T00:00:00.000Z",
};

test("project memory keeps context scoped to the requested project", () => {
  const memory = new ProjectMemory();
  memory.add(entry);
  memory.add({ ...entry, id: "dmi-pattern-1", project: "dmi-finance", title: "VKYC consent", tags: ["consent"] });

  assert.equal(memory.list("express-computers").length, 1);
  assert.equal(memory.search({ project: "dmi-finance" })[0].id, "dmi-pattern-1");
});

test("project memory search prioritizes verified evidence and normalizes tags", () => {
  const memory = new ProjectMemory();
  memory.add(entry);
  memory.add({ ...entry, id: "unverified", verified: false, title: "Filter idea", source: "Unconfirmed note" });

  const results = memory.search({ project: "express-computers", query: "FILTER" });
  assert.equal(results[0].id, "express-pattern-1");
  assert.deepEqual(results[0].tags, ["table", "filter"]);
});

test("project memory requires source provenance", () => {
  const memory = new ProjectMemory();
  assert.throws(() => memory.add({ ...entry, source: " " }), /provenance/);
});
