import test from "node:test";
import assert from "node:assert/strict";
import {
  extractNumbers,
  resolveContentMode,
  runStructuralLint,
  summarizeStructuralLint,
} from "../src/figma-agent/structural-lint";

type N = Record<string, unknown>;
const text = (id: string, value: string, x: number, y: number, w = 120, h = 20, extra: N = {}): N =>
  ({ id, type: "TEXT", name: id, text: value, x, y, width: w, height: h, ...extra });
const frame = (id: string, children: N[], extra: N = {}): N =>
  ({ id, type: "FRAME", name: id, x: 0, y: 0, width: 360, height: 640, childCount: children.length, children, ...extra });
const canvas = (root: N, truncated = false) => ({ nodes: [root], truncated });

const loanSource = canvas(frame("src", [
  text("t1", "Manage loans", 16, 16),
  frame("ring", [{ id: "e1", type: "ELLIPSE", name: "Progress", x: 0, y: 0, width: 80, height: 80 }], { x: 16, y: 60, width: 80, height: 80 }),
  text("t2", "60% paid", 110, 80),
  text("t3", "Loan 1 · ₹50,000", 16, 160),
  text("t4", "Loan 2 · ₹1,20,000", 16, 200),
  { id: "v1", type: "VECTOR", name: "Chevron", x: 320, y: 160, width: 16, height: 16 },
]));

test("clean, faithful output passes", () => {
  const output = canvas(frame("out", [
    text("o1", "Manage loans", 16, 16),
    { id: "o2", type: "ELLIPSE", name: "Ring", x: 16, y: 60, width: 80, height: 80 },
    text("o3", "60% paid", 110, 80),
    text("o4", "Loan 1 · ₹50,000", 16, 160),
    text("o5", "Loan 2 · ₹1,20,000", 16, 200),
    { id: "o6", type: "VECTOR", name: "Chevron", x: 320, y: 160, width: 16, height: 16 },
  ], { x: 500 }));
  const result = runStructuralLint({ prompt: "Create a cleaner variation of this screen", sourceCanvas: loanSource, outputCanvas: output });
  assert.equal(result.passed, true, JSON.stringify(result.issues));
  assert.match(summarizeStructuralLint(result), /passed · 4\/4 source texts kept/);
});

test("dropped row, value and progress ring are reported as high severity", () => {
  const output = canvas(frame("out", [
    text("o1", "Manage loans", 16, 16),
    text("o3", "60% paid", 110, 80),
    text("o4", "Loan 1 · ₹50,000", 16, 160),
    { id: "o6", type: "VECTOR", name: "Chevron", x: 320, y: 160, width: 16, height: 16 },
  ]));
  const result = runStructuralLint({ prompt: "Create a variation", sourceCanvas: loanSource, outputCanvas: output });
  assert.equal(result.passed, false);
  assert.deepEqual(result.content.missingText, ["loan 2 · ₹1,20,000"]);
  assert.ok(result.content.missingNumbers.includes("₹1,20,000"));
  assert.ok(result.issues.some(issue => /source text item/.test(issue.issue) && issue.severity === "high"));
  assert.ok(result.issues.some(issue => /Circular graphics/.test(issue.issue)));
  // The missing value is covered by the missing-text finding, so it is not reported twice.
  assert.ok(!result.issues.some(issue => /source value/.test(issue.issue)));
});

test("text split across layers still counts as preserved", () => {
  const output = canvas(frame("out", [
    text("o1", "Manage loans", 16, 16),
    { id: "o2", type: "ELLIPSE", name: "Ring", x: 16, y: 60, width: 80, height: 80 },
    text("o3", "60% paid", 110, 80),
    text("a", "Loan 1", 16, 160, 60), text("b", "₹50,000", 200, 160, 80),
    text("c", "Loan 2", 16, 200, 60), text("d", "₹1,20,000", 200, 200, 80),
    { id: "o6", type: "VECTOR", name: "Chevron", x: 320, y: 160, width: 16, height: 16 },
  ]));
  const result = runStructuralLint({ prompt: "Create a variation", sourceCanvas: loanSource, outputCanvas: output });
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("copy-change requests only check numbers; removal requests skip content checks", () => {
  assert.equal(resolveContentMode("Rewrite the copy in Hindi").mode, "numbers-only");
  assert.equal(resolveContentMode("Remove the second loan row").mode, "skipped");
  assert.equal(resolveContentMode("Make a dark mode variation").mode, "full");
  const output = canvas(frame("out", [
    text("o1", "Mere loans", 16, 16),
    { id: "o2", type: "ELLIPSE", name: "Ring", x: 16, y: 60, width: 80, height: 80 },
    text("o3", "60% chuka", 110, 80),
    text("o4", "Loan 1 · ₹50,000", 16, 160),
    text("o5", "Loan 2 · ₹1,20,000", 16, 200),
  ]));
  const result = runStructuralLint({ prompt: "Translate the copy to Hinglish", sourceCanvas: loanSource, outputCanvas: output });
  assert.equal(result.passed, true, JSON.stringify(result.issues));
});

test("truncated or depth-limited output downgrades absence to an unverified finding", () => {
  const output = canvas(frame("out", [text("o1", "Manage loans", 16, 16), { id: "deep", type: "FRAME", name: "Rows", x: 0, y: 150, width: 360, height: 100, childCount: 4 }]));
  const result = runStructuralLint({ prompt: "Create a variation", sourceCanvas: loanSource, outputCanvas: output });
  assert.equal(result.content.partial, true);
  assert.ok(result.issues.some(issue => issue.severity === "medium" && /could not be fully verified/.test(issue.issue)));
  assert.ok(!result.issues.some(issue => /are missing from the output/.test(issue.issue)));
});

test("overlapping text layers and icon-on-text are flagged", () => {
  const output = canvas(frame("out", [
    text("a", "Angora cardigan", 16, 16, 140, 20),
    text("b", "$120", 100, 20, 60, 20),
    { id: "heart", type: "INSTANCE", name: "Heart", x: 20, y: 16, width: 20, height: 20 },
  ]));
  const result = runStructuralLint({ prompt: "x", outputCanvas: output });
  assert.equal(result.layout.overlaps, 2);
  assert.ok(result.issues.some(issue => issue.severity === "high" && /Two text layers overlap/.test(issue.issue)));
  assert.ok(result.issues.some(issue => issue.severity === "medium" && /icon overlaps text/.test(issue.issue)));
});

test("absolute badge text over an icon is treated as an intentional overlay", () => {
  const output = canvas(frame("out", [
    { id: "bell", type: "VECTOR", name: "Bell", x: 16, y: 16, width: 24, height: 24 },
    text("count", "3", 28, 14, 14, 14, { layoutPositioning: "ABSOLUTE" }),
  ]));
  assert.equal(runStructuralLint({ prompt: "x", outputCanvas: output }).passed, true);
});

test("text clipped by a clipping card and collapsed text are flagged; nested coordinates are parent-relative", () => {
  const card = frame("card", [
    text("inside", "Fits", 8, 8, 100, 20),
    text("spill", "This overflows the card", 8, 30, 300, 20),
  ], { x: 20, y: 100, width: 200, height: 60, clipsContent: true });
  const output = canvas(frame("out", [card, text("thin", "Squashed", 16, 300, 0.5, 400)]));
  const result = runStructuralLint({ prompt: "x", outputCanvas: output });
  assert.equal(result.layout.clipped, 1);
  assert.equal(result.layout.collapsedText, 1);
  assert.ok(result.issues.some(issue => /clipped/.test(issue.issue) && issue.evidence.includes("spill")));
  assert.ok(!result.issues.some(issue => issue.evidence.includes("inside")));
});

test("hidden layers are ignored and instance text props count as output text", () => {
  const source = canvas(frame("src", [text("t", "Pay now", 0, 0), text("h", "Hidden copy", 0, 40, 120, 20, { visible: false })]));
  const output = canvas(frame("out", [{ id: "btn", type: "INSTANCE", name: "Button", x: 0, y: 0, width: 120, height: 40, componentProperties: { Label: "Pay now" } }]));
  const result = runStructuralLint({ prompt: "Create a variation", sourceCanvas: source, outputCanvas: output });
  assert.equal(result.content.sourceTextCount, 1);
  assert.deepEqual(result.content.missingText, []);
});

test("number extraction keeps currency and percent forms", () => {
  assert.deepEqual(extractNumbers("₹1,20,000 due on 12/03/2026, 60% paid."), ["₹1,20,000", "12/03/2026", "60%"]);
});

test("variation completion and visual review both enforce the deterministic structural lint", async () => {
  const { readFileSync } = await import("node:fs");
  const ui = readFileSync("figma-plugin/ui.html", "utf8");
  const review = readFileSync("app/api/assistant/figma-agent/review/route.ts", "utf8");
  const flow = ui.slice(ui.indexOf("async function createFigmaDesign("), ui.indexOf("async function captureRenderedNodePreview("));
  assert.ok(flow.includes("await runStructuralLintGate({"), "Variation completion runs the structural lint gate.");
  assert.ok(flow.includes('finalizeTaskOutcome(lint.passed ? "verified" : "failed"'), "A lint failure is never logged as a verified success.");
  assert.ok(ui.includes('fetch(API + "/api/assistant/figma-agent/lint"'));
  assert.ok(review.includes("runStructuralLint({"), "Visual review merges deterministic findings.");
  assert.ok(review.includes("structuralHigh ? Math.min(validated.data.score, 70)"), "High-severity structural defects cap the score below the gate.");
});
