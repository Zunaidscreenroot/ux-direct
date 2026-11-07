import test from "node:test";
import assert from "node:assert/strict";
import { buildDesignerLesson } from "../src/memory/designer-feedback";
import { assessBrainRelevance } from "../src/memory/learning-signal";

test("a critique becomes a generic lesson that passes the brain relevance gate", () => {
  const lesson = buildDesignerLesson("critique", "this is not simplified", "make this screen simplified\nFEEDBACK ON THE PREVIOUS ATTEMPT (rejected by the designer): \"x\"");
  assert.ok(lesson);
  assert.match(lesson!.title, /make this screen simplified/);
  assert.doesNotMatch(lesson!.normalizedRule, /FEEDBACK ON THE PREVIOUS ATTEMPT/);
  assert.match(lesson!.normalizedRule, /never return a near copy/);
  assert.match(lesson!.normalizedRule, /Useful moves/, "simplify gets its concrete moves");
  assert.equal(assessBrainRelevance(lesson!.title, [lesson!.rawFeedback, lesson!.normalizedRule, lesson!.rationale].join("\n"), "UX_SHARED_BRAIN").eligible, true);
});

test("explanations become guidance; private details are never saved", () => {
  const lesson = buildDesignerLesson("explanation", "simplified ka matlab hai kam colours aur ek CTA");
  assert.ok(lesson);
  assert.equal(lesson!.originalLanguage, "Hinglish");
  assert.equal(assessBrainRelevance(lesson!.title, [lesson!.rawFeedback, lesson!.normalizedRule, lesson!.rationale].join("\n"), "UX_SHARED_BRAIN").eligible, true);
  assert.equal(buildDesignerLesson("explanation", "call me on 9876543210 for the screen"), null);
  assert.equal(buildDesignerLesson("rule", "  "), null);
});
