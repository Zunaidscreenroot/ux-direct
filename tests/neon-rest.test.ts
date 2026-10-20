import test from "node:test";
import assert from "node:assert/strict";
import { serializeDatabaseValue } from "../src/memory/neon-rest";

test("serializes an empty JSONB examples array as JSON text, not a PostgreSQL array", () => {
  assert.equal(serializeDatabaseValue("uxd_brain_feedback", "examples", "[]"), "[]");
  assert.equal(serializeDatabaseValue("uxd_brain_feedback", "examples", []), "[]");
});

test("serializes JSONB objects and non-empty arrays explicitly", () => {
  assert.equal(
    serializeDatabaseValue("uxd_brain_feedback", "examples", [{ before: "old", after: "new" }]),
    '[{"before":"old","after":"new"}]',
  );
  assert.equal(
    serializeDatabaseValue("uxd_knowledge_documents", "metadata", { sourceProduct: "ux-direct" }),
    '{"sourceProduct":"ux-direct"}',
  );
});

test("does not serialize PostgreSQL array columns or unrelated scalar values", () => {
  const keywords = ["figma", "interaction"];
  assert.equal(serializeDatabaseValue("uxd_brain_feedback", "keywords", keywords), keywords);
  assert.equal(serializeDatabaseValue("uxd_brain_feedback", "raw_feedback", "A reusable rule"), "A reusable rule");
  assert.equal(serializeDatabaseValue("uxd_brain_feedback", "examples", null), null);
});
