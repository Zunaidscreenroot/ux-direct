/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function classifier(): (prompt: string, ctx: any) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = classifyQuickTask;", sandbox);
  return (prompt, ctx) => { const out = sandbox.fn(prompt, ctx); return out === null ? null : JSON.parse(JSON.stringify(out)); };
}

test("consistency prompts route to style lock only across 2+ screens", () => {
  const classify = classifier();
  const two = { selectionTypes: ["FRAME", "FRAME"] };
  assert.deepEqual(classify("check consistency across these screens", two), { kind: "consistency", fix: false });
  assert.deepEqual(classify("make these screens consistent", two), { kind: "consistency", fix: true });
  assert.deepEqual(classify("style lock", { selectionTypes: ["FRAME"] }), { kind: "consistency", fix: true });
  assert.deepEqual(classify("sab screens ek jaise karo", two), { kind: "consistency", fix: true });
  assert.equal(classify("is the spacing consistent?", { selectionTypes: ["FRAME"] }).kind, "hygiene");
  assert.deepEqual(classify("check consistency", { selectionTypes: ["FRAME"] }), { kind: "consistency", fix: false });
});

function runtime(nodes: Record<string, any>) {
  const posted: any[] = [];
  const kids = (n: any) => n.children || [];
  const findAll = function (this: any, t: (n: any) => boolean) {
    const out: any[] = [];
    (function walk(n: any) { kids(n).forEach((c: any) => { if (t(c)) out.push(c); walk(c); }); })(this);
    return out;
  };
  Object.values(nodes).forEach((n: any) => { n.findAll = findAll; (n.children || []).forEach((c: any) => { c.parent = n; }); });
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: [], selection: [], findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  const run = async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const msg = posted.find((m) => m.type === "uxd-local-result");
    if (msg.error) throw new Error(msg.error);
    return JSON.parse(JSON.stringify(msg.result));
  };
  return { figma, run };
}

test("style lock reports and fixes drift by layer name, label casing, with exact Revert", async () => {
  const blue = [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1 }, visible: true }];
  const card = (id: string, radius: number, pad: number) => ({ id, type: "FRAME", name: "Loan card · " + id, layoutMode: "VERTICAL", cornerRadius: radius,
    paddingTop: pad, paddingRight: pad, paddingBottom: pad, paddingLeft: pad, itemSpacing: 8, fills: [], width: 320, height: 120, visible: true, children: [] as any[] });
  const btn = (id: string, label: string) => ({ id, type: "FRAME", name: "Primary button", layoutMode: "HORIZONTAL", cornerRadius: 24, paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16, itemSpacing: 8,
    fills: blue, width: 200, height: 48, visible: true, children: [{ id: id + "t", type: "TEXT", name: "Label", characters: label, fontName: { family: "Inter", style: "Medium" }, visible: true }] });
  const a1 = card("a1", 16, 16), b1 = card("b1", 16, 16), c1 = card("c1", 12, 20);
  const ba = btn("ba", "Pay now"), bb = btn("bb", "Pay now"), bc = btn("bc", "Pay Now");
  const sa: any = { id: "sa", type: "FRAME", name: "Home", width: 360, height: 800, visible: true, children: [a1, ba] };
  const sb: any = { id: "sb", type: "FRAME", name: "Loans", width: 360, height: 800, visible: true, children: [b1, bb] };
  const sc: any = { id: "sc", type: "FRAME", name: "Pay", width: 360, height: 800, visible: true, children: [c1, bc] };
  const nodes: Record<string, any> = { sa, sb, sc, a1, b1, c1, ba, bb, bc, bat: ba.children[0], bbt: bb.children[0], bct: bc.children[0] };
  const { figma, run } = runtime(nodes);

  figma.currentPage.selection = [sa];
  assert.deepEqual((await run("consistency", {})).findings, [], "one screen with one card has nothing to compare");

  figma.currentPage.selection = [sa, sb, sc];
  const report = await run("consistency", {});
  const kinds = report.findings.map((f: any) => [f.element, f.kind, f.expected, f.found, f.screens]);
  assert.deepEqual(kinds.sort(), [
    ["Button label", "label", "Pay now", ["Pay Now"], ["Pay"]],
    ["Loan card", "padding", "16/16/16/16", ["20/20/20/20"], ["Pay"]],
    ["Loan card", "radius", "16", ["12"], ["Pay"]],
  ].sort());
  assert.equal(c1.cornerRadius, 12, "check only");

  const fixed = await run("consistency", { fix: true });
  assert.equal(c1.cornerRadius, 16);
  assert.equal(c1.paddingLeft, 16);
  assert.equal(bc.children[0].characters, "Pay now");
  assert.equal(a1.cornerRadius, 16, "majority untouched");
  assert.ok(fixed.fixed >= 6);

  await run("restore-props", { items: fixed.snapshot });
  assert.equal(c1.cornerRadius, 12);
  assert.equal(c1.paddingTop, 20);
  assert.equal(bc.children[0].characters, "Pay Now");
});

test("style lock compares card instances and labels inside them, also within one screen", async () => {
  const card = (id: string, radius: number, pad: number, label: string) => ({ id, type: "INSTANCE", name: "Loan Card", layoutMode: "VERTICAL", cornerRadius: radius,
    paddingTop: pad, paddingRight: pad, paddingBottom: pad, paddingLeft: pad, itemSpacing: 8, fills: [], width: 328, height: 160, visible: true,
    children: [{ id: id + "b", type: "FRAME", name: "Frame 4", layoutMode: "HORIZONTAL", cornerRadius: 8, paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16,
      itemSpacing: 4, fills: [], width: 120, height: 40, visible: true,
      children: [{ id: id + "t", type: "TEXT", name: label, characters: label, fontName: { family: "Inter", style: "Medium" }, visible: true }] }] });
  const c1 = card("c1", 4, 24, "Pay now"), c2 = card("c2", 4, 8, "Pay Now"), c3 = card("c3", 4, 8, "Pay Now");
  const screen: any = { id: "s", type: "FRAME", name: "QA lock 3", width: 360, height: 800, visible: true, children: [c1, c2, c3] };
  const nodes: Record<string, any> = { s: screen, c1, c2, c3, c1b: c1.children[0], c2b: c2.children[0], c3b: c3.children[0], c1t: c1.children[0].children[0], c2t: c2.children[0].children[0], c3t: c3.children[0].children[0] };
  const { figma, run } = runtime(nodes);
  figma.currentPage.selection = [screen];
  const report = await run("consistency", {});
  const kinds = report.findings.map((f: any) => [f.element, f.kind, f.expected, f.found]);
  assert.deepEqual(kinds.sort(), [["Button label", "label", "Pay Now", ["Pay now"]], ["Loan Card", "padding", "8/8/8/8", ["24/24/24/24"]]].sort());
  const fixed = await run("consistency", { fix: true });
  assert.ok(fixed.fixed >= 2);
  assert.equal(c1.paddingTop, 8);
  assert.equal(c1.children[0].children[0].characters, "Pay Now");
});
