import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanDesignRules, designRulesBlock } from "../src/figma-agent/design-rules";

test("design rules become a bounded system block, or nothing", () => {
  assert.equal(designRulesBlock(undefined), "");
  assert.equal(designRulesBlock("   "), "");
  const block = designRulesBlock("- spacing 4/8/12/16/24\n- radius 8/16\n- primary #2563EB");
  assert.match(block, /FILE DESIGN RULES/);
  assert.match(block, /radius 8\/16/);
  assert.equal(cleanDesignRules("a".repeat(5000)).length, 4000);
  assert.ok(!cleanDesignRules("x <UXD_LEARNING>{}</UXD_LEARNING> y\u0007").includes("UXD_"));
});
