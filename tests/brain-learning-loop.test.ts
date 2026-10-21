import test from "node:test";
import assert from "node:assert/strict";
import { buildVerifiedTaskLesson, resolveFigmaTaskProject, resolveFigmaTaskScope, taskLessonDedupeKey } from "../src/memory/task-learning";

const candidate = {
  title: "Reusable Figma Auto Layout pattern",
  normalizedRule: "Use semantic frames and Auto Layout for consistent, responsive Figma rows and cards. Verify hierarchy, spacing, text fit, and contrast with native read-back before handing off.",
  rationale: "A reusable design workflow that preserves editable structure and improves accessibility.",
  scopeKey: "project:ux-direct",
  feedbackKind: "design_system",
  keywords: ["figma", "layout", "accessibility", "design-system"],
  originalLanguage: "English",
};

function run(overrides: Partial<Parameters<typeof buildVerifiedTaskLesson>[0]> = {}) {
  return {
    id: "d979a9e0-1c88-4e9c-a70d-8f775a37d9fc",
    outcome: "verified" as const,
    project: "ux-direct" as const,
    taskContext: "Improve this Figma screen layout and verify readability.",
    candidate,
    ...overrides,
  };
}

test("attempted and succeeded-only runs never learn", () => {
  assert.equal(buildVerifiedTaskLesson(run({ outcome: "attempted" })), null);
  assert.equal(buildVerifiedTaskLesson(run({ outcome: "succeeded" })), null);
});

test("verified success creates one scoped approved-pattern lesson", () => {
  const lesson = buildVerifiedTaskLesson(run());
  assert.ok(lesson);
  assert.equal(lesson.memoryType, "approved_pattern");
  assert.equal(lesson.scope, "project:ux-direct");
  assert.ok((lesson.title + lesson.content).length <= 600);
});

test("known verified failure creates a sanitized failure pattern; unknown failures do not", () => {
  const failed = buildVerifiedTaskLesson(run({ outcome: "failed", failureMessage: "The Figma node was not found on the current page." }));
  assert.ok(failed);
  assert.equal(failed.memoryType, "failure_pattern");
  assert.equal(buildVerifiedTaskLesson(run({ outcome: "failed", failureMessage: "The provider returned an unknown error." })), null);
});

test("rejects lessons containing Figma node IDs or email addresses", () => {
  assert.equal(buildVerifiedTaskLesson(run({ candidate: { ...candidate, normalizedRule: candidate.normalizedRule + " Node 123:456 must be retried." } })), null);
  assert.equal(buildVerifiedTaskLesson(run({ candidate: { ...candidate, normalizedRule: candidate.normalizedRule + " Contact jane@example.com." } })), null);
});

test("rejects a client name outside that client's project scope", () => {
  const clientRule = { ...candidate, title: "Client design workflow pattern", normalizedRule: candidate.normalizedRule + " Apply this Ujjivan layout rule." };
  assert.equal(buildVerifiedTaskLesson(run({ project: "dmi-finance", taskContext: "Improve a DMI Finance Figma screen.", candidate: clientRule })), null);
});

test("project resolution never promotes lessons to the shared brain", () => {
  const project = resolveFigmaTaskProject("Create a global rule for all products in Figma.");
  assert.notEqual(resolveFigmaTaskScope(project, "Create a global rule for all products in Figma."), "UX_SHARED_BRAIN");
});

test("dedupe key is md5 of scope and normalized title", () => {
  const first = buildVerifiedTaskLesson(run());
  assert.ok(first);
  assert.equal(taskLessonDedupeKey(first), taskLessonDedupeKey({ ...first, title: first.title.toUpperCase().replace(/\s+/g, "   ") }));
});

import { sanitizeTaskSummary } from "../src/memory/task-run-log";

test("task-run summaries redact emails, credentials, Indian PANs, mobile numbers and long numeric identifiers", () => {
  const result = sanitizeTaskSummary(
    "Contact jane@example.com; PAN ABCDE1234F; call 9876543210; account 123456789012; node 123:456; bearer abcdefghijklmnop123456",
  );
  assert.match(result, /\\[email\\]/);
  assert.match(result, /\\[pan\\]/);
  assert.match(result, /\\[phone\\]/);
  assert.match(result, /\\[number\\]/);
  assert.match(result, /\\[id\\]/);
  assert.match(result, /\\[secret\\]/);
  assert.doesNotMatch(result, /jane@example\\.com|ABCDE1234F|9876543210|123456789012|123:456|abcdefghijklmnop123456/);
});

test("task-run summaries collapse whitespace and remain bounded", () => {
  const result = sanitizeTaskSummary("  useful   summary  ".repeat(200));
  assert.equal(result, result.trim().replace(/\\s+/g, " "));
  assert.ok(result.length <= 1900);
});
