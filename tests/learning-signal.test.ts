import test from "node:test";
import assert from "node:assert/strict";
import { detectCoachingSignal, detectExplicitTrainingIntent, resolveLearningScope } from "../src/memory/learning-signal";

test("detects natural English feedback as a coaching signal", () => {
  assert.equal(detectCoachingSignal("You marked every CTA as high priority. That was wrong; remember this for future audits."), true);
});

test("detects natural Hindi/Hinglish feedback without a special instruction", () => {
  assert.equal(detectCoachingSignal("Is screen mein CTA hierarchy galat thi. Aisa hona chahiye tha; aage se ye galti mat repeat karna."), true);
});

test("does not treat an ordinary design brief as training", () => {
  assert.equal(detectCoachingSignal("Create a mobile loan application screen with consent, retry, and error states."), false);
});

test("only explicit future-learning intent counts as approval intent", () => {
  assert.equal(detectExplicitTrainingIntent("You should have made the secondary CTA less prominent."), false);
  assert.equal(detectExplicitTrainingIntent("Remember this rule for future audits."), true);
  assert.equal(detectExplicitTrainingIntent("Aage se ye galti mat repeat karna."), true);
});

test("keeps project-specific feedback in the project's scope by default", () => {
  assert.equal(resolveLearningScope("UX_SHARED_BRAIN", "dmi-finance", "That was wrong."), "project:dmi-finance");
  assert.equal(resolveLearningScope("UX_SHARED_BRAIN", "express-computers", "That was wrong."), "project:express-computers");
});

test("allows broader learning scope only when owner explicitly generalizes it", () => {
  assert.equal(resolveLearningScope("UX_SHARED_BRAIN", "dmi-finance", "Remember this across all products as a global rule."), "UX_SHARED_BRAIN");
  assert.equal(resolveLearningScope("indian-bfsi", "general", "Make this rule for future Indian BFSI audits."), "indian-bfsi");
});
