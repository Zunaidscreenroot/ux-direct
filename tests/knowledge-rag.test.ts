import test from "node:test";
import assert from "node:assert/strict";
import { resolveKnowledgeProjectKey } from "../src/figma/knowledge-rag";

test("maps DMI project aliases to the isolated DMI namespace", () => {
  assert.equal(resolveKnowledgeProjectKey("dmi-housing-finance"), "DMI_HFC");
  assert.equal(resolveKnowledgeProjectKey("DMI HFC"), "DMI_HFC");
  assert.equal(resolveKnowledgeProjectKey("DMI_HFC"), "DMI_HFC");
});

test("maps Ujjivan aliases to the isolated Ujjivan namespace", () => {
  assert.equal(resolveKnowledgeProjectKey("ujjivan-sfb"), "UJJIVAN_SFB");
  assert.equal(resolveKnowledgeProjectKey("Ujjivan Small Finance Bank"), "UJJIVAN_SFB");
  assert.equal(resolveKnowledgeProjectKey("UJJIVAN_SFB"), "UJJIVAN_SFB");
});

test("allows the shared Indian BFCI namespace", () => {
  assert.equal(resolveKnowledgeProjectKey("INDIA_BFCI_SHARED"), "INDIA_BFCI_SHARED");
  assert.equal(resolveKnowledgeProjectKey("shared-bfci"), "INDIA_BFCI_SHARED");
});

test("rejects unrelated projects rather than leaking their knowledge", () => {
  assert.equal(resolveKnowledgeProjectKey("another-client"), null);
  assert.equal(resolveKnowledgeProjectKey(""), null);
});
