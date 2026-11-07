/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function block(): any {
  const match = /\/\/ uxd-fill-data:start([\s\S]*?)\/\/ uxd-fill-data:end/.exec(code);
  assert.ok(match);
  const sandbox: any = { Math, Number, String, Map, isFinite };
  runInNewContext(match[1] + "\nthis.fake = uxdFakeValue; this.seeded = uxdSeeded; this.group = uxdIndianGroup;", sandbox);
  return sandbox;
}
function classifier(): (prompt: string, ctx: any) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = classifyQuickTask;", sandbox);
  return (prompt, ctx) => { const out = sandbox.fn(prompt, ctx); return out === null ? null : JSON.parse(JSON.stringify(out)); };
}

test("sample-data prompts route to the deterministic filler", () => {
  const classify = classifier();
  const frame = { selectionTypes: ["FRAME"] };
  for (const prompt of ["fill with realistic data", "add dummy data", "dummy data bhar do", "use sample Indian names and amounts", "populate the table with sample data"]) {
    assert.equal(classify(prompt, frame)?.kind, "fill-data", prompt);
  }
  assert.equal(classify("fill different sample data", frame).reshuffle, true);
  assert.equal(classify("Replace the lorem ipsum with realistic loan content", frame).kind, "rewrite-text", "lorem stays on the model rewrite path");
  assert.notEqual(classify("fill with realistic data", { selectionTypes: [] })?.kind, "fill-data");
});

test("values keep their exact format and labels are never touched", () => {
  const b = block();
  const r = () => b.seeded("1:2");
  assert.equal(b.group(1250000), "12,50,000");
  assert.match(b.fake("₹12,500", r()), /^₹\d{1,2},\d{3}$/);
  assert.match(b.fake("₹1,20,000", r()), /^₹(\d{1,2},)?\d{2},\d{3}$/);
  assert.match(b.fake("Rs. 4,999.00", r()), /^Rs\. [\d,]+\.\d{2}$/);
  assert.match(b.fake("5 Dec 2026", r()), /^\d{1,2} [A-Z][a-z]{2} 2026$/);
  assert.match(b.fake("05/12/2026", r()), /^\d{2}\/\d{2}\/2026$/);
  assert.match(b.fake("XXXX 1234", r()), /^XXXX \d{4}$/);
  assert.match(b.fake("A/c ****5678", r()), /^A\/c \*{4}\d{4}$/);
  assert.match(b.fake("LN-20481", r()), /^LN-\d{5}$/);
  assert.match(b.fake("ABCPE1234F", r()), /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/);
  assert.match(b.fake("+91 98765 43210", r()), /^\+91 [6-9]\d{4} \d{5}$/);
  assert.match(b.fake("10.5% p.a.", r()), /^\d{1,2}\.\d% p\.a\.$/);
  assert.match(b.fake("Rahul Sharma", r()), /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  for (const label of ["Loan Summary", "Pay now", "Active", "Overdue", "EMI due", "Personal Loan", "Total outstanding", "View Details"]) {
    assert.equal(b.fake(label, r()), null, label);
  }
  assert.equal(b.fake("₹12,500", b.seeded("1:2")), b.fake("₹12,500", b.seeded("1:2")), "same layer, same value");
  assert.notEqual(b.fake("₹12,500", b.seeded("1:2")), b.fake("₹12,500", b.seeded("1:9")), "repeated rows differ");
});
