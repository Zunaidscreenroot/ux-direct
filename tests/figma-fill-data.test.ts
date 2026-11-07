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
  for (const prompt of ["fill different data", "fill new values", "shuffle the data", "alag data daal do", "try another set"]) {
    assert.equal(classify(prompt, frame)?.kind, "fill-data", prompt);
    assert.equal(classify(prompt, frame).reshuffle, true, prompt);
  }
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

test("revert restores from a snapshot, only where the text is still what UX Direct wrote", async () => {
  const nodes: any = { "1": { id: "1", type: "TEXT", characters: "₹9,450", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames() { return [this.fontName]; } },
    "2": { id: "2", type: "TEXT", characters: "edited by designer", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames() { return [this.fontName]; } } };
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: [], selection: [], findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op: "restore-texts", payload: { edits: [
    { id: "1", text: "₹10,000", expect: "₹9,450" }, { id: "2", text: "₹10,000", expect: "₹7,200" }, { id: "3", text: "x", expect: "y" }] } });
  const result = posted.find((m) => m.type === "uxd-local-result").result;
  assert.equal(nodes["1"].characters, "₹10,000");
  assert.equal(nodes["2"].characters, "edited by designer", "a later manual edit is kept");
  assert.deepEqual([result.restored, result.changedSince, result.missing], [1, 1, 1]);
});

test("amounts in any currency keep their symbol and grouping style", () => {
  const { fake, seeded } = block();
  const rand = seeded(7);
  assert.match(fake("$1,250.00", rand), /^\$\d{1,3}(,\d{3})*\.\d{2}$/);
  assert.match(fake("€89", rand), /^€\d+$/);
  assert.match(fake("USD 2,000,000", rand), /^USD \d{1,3}(,\d{3})+$/);
  assert.match(fake("₹1,20,000", rand), /^₹\d{1,2}(,\d{2})*,\d{3}$/);
  assert.match(fake("AED 4,999/mo", rand), /^AED \d{1,3}(,\d{3})*\/mo$/);
});
