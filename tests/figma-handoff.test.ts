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

test("handoff and prototype prompts route to their tasks", () => {
  const classify = classifier();
  const one = { selectionTypes: ["FRAME"] }, two = { selectionTypes: ["FRAME", "FRAME"] };
  assert.deepEqual(classify("add handoff notes", one), { kind: "handoff" });
  assert.deepEqual(classify("annotate this for dev", one), { kind: "handoff" });
  assert.deepEqual(classify("wire the prototype", two), { kind: "prototype-wire", fix: true });
  assert.deepEqual(classify("connect these screens", two), { kind: "prototype-wire", fix: true });
  assert.deepEqual(classify("show which buttons link the screens", two), { kind: "prototype-wire", fix: false });
  assert.equal(classify("relink detached components", two).kind, "detached");
});

function decorate(n: any, parent: any): any {
  n.parent = parent; n.visible = n.visible !== false;
  n.findAll = function (t: (x: any) => boolean) {
    const out: any[] = [];
    (function walk(x: any) { (x.children || []).forEach((c: any) => { if (t(c)) out.push(c); walk(c); }); })(n);
    return out;
  };
  if (n.type !== "TEXT") { n.annotations = n.annotations || []; n.reactions = n.reactions || []; n.setReactionsAsync = async (r: any) => { n.reactions = r; }; }
  (n.children || []).forEach((c: any) => decorate(c, n));
  return n;
}
function runtime(selection: any[], nodes: Record<string, any>) {
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: [], selection, findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
  };
  selection.forEach((s) => decorate(s, figma.currentPage));
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  return async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const msg = posted.find((m) => m.type === "uxd-local-result");
    if (msg.error) throw new Error(msg.error);
    return JSON.parse(JSON.stringify(msg.result));
  };
}
const txt = (id: string, characters: string) => ({ id, type: "TEXT", name: characters, characters });
const button = (id: string, label: string, extra: any = {}) => ({ id, type: "FRAME", name: "Primary button", layoutMode: "HORIZONTAL", width: 200, height: 40, cornerRadius: 8,
  fills: [{ type: "SOLID" }], strokes: [], children: [txt(id + "t", label)], ...extra });

test("handoff notes annotate screen, buttons and inputs, keep the designer's notes, and revert exactly", async () => {
  const pay = button("b1", "Pay now", { annotations: [{ labelMarkdown: "Designer: use brand blue" }] });
  const input: any = { id: "i1", type: "FRAME", name: "Amount input", layoutMode: "HORIZONTAL", width: 320, height: 48, cornerRadius: 8, fills: [], strokes: [{ type: "SOLID" }], children: [txt("i1t", "Enter amount")] };
  const screen: any = { id: "s1", type: "FRAME", name: "Home", width: 360, height: 800, fills: [], strokes: [], children: [pay, input] };
  const nodes = { s1: screen, b1: pay, i1: input };
  const run = runtime([screen], nodes);
  const result = await run("handoff-notes", {});
  assert.deepEqual(result.notes.map((n: any) => n.kind), ["screen", "button", "input"]);
  assert.equal(pay.annotations.length, 2);
  assert.equal(pay.annotations[0].labelMarkdown, "Designer: use brand blue");
  assert.match(pay.annotations[1].labelMarkdown, /Button "Pay now"\. States: default, pressed, disabled, loading\. Height is 40px/);
  assert.deepEqual(JSON.parse(JSON.stringify(pay.annotations[1].properties)).map((p: any) => p.type), ["width", "height", "cornerRadius", "fills", "padding"]);
  assert.deepEqual(JSON.parse(JSON.stringify(input.annotations[0].properties)).map((p: any) => p.type), ["width", "height", "cornerRadius", "strokes", "padding"]);

  await run("handoff-notes", {});
  assert.equal(pay.annotations.length, 2, "re-running replaces only UX Direct notes");

  // Figma reads notes back with both label and labelMarkdown and refuses both on write.
  const strict = (node: any) => { let value = node.annotations; Object.defineProperty(node, "annotations", { get: () => value,
    set: (v: any[]) => { if (v.some((a) => a.label && a.labelMarkdown)) throw new Error("both label and labelMarkdown"); value = v.map((a) => ({ ...a, label: a.labelMarkdown || a.label })); } }); };
  strict(pay); strict(input);
  pay.annotations = pay.annotations.map((a: any) => ({ labelMarkdown: a.labelMarkdown, properties: a.properties }));
  const again = await run("handoff-notes", {});
  assert.equal(pay.annotations.length, 2);
  const reverted = await run("restore-props", { items: again.snapshot });
  assert.equal(reverted.missing, 0);
  assert.equal(pay.annotations.length, 1, "Revert strips every UX Direct note, even after reruns");
  assert.equal(pay.annotations[0].labelMarkdown, "Designer: use brand blue");
  assert.equal(input.annotations.length, 0);
});

test("prototype wire links by screen name, Back and Continue, skips wired buttons, and reverts", async () => {
  const home: any = { id: "h", type: "FRAME", name: "Home", x: 0, y: 0, width: 360, height: 800, children: [button("hb1", "Pay EMI"), button("hb2", "Continue"), button("hb3", "Help", { reactions: [{ trigger: { type: "ON_CLICK" } }] })] };
  const pay: any = { id: "p", type: "FRAME", name: "EMI payment", x: 400, y: 0, width: 360, height: 800, children: [button("pb1", "Back"), button("pb2", "Something")] };
  const nodes: Record<string, any> = { h: home, p: pay };
  const run = runtime([pay, home], nodes);
  [...home.children, ...pay.children].forEach((b: any) => { nodes[b.id] = b; });

  const plan = await run("prototype-wire", {});
  assert.deepEqual(plan.screens, ["Home", "EMI payment"]);
  assert.deepEqual(plan.links.map((l: any) => [l.label, l.action, l.to]), [["Pay EMI", "NAVIGATE", "EMI payment"], ["Continue", "NAVIGATE", "EMI payment"], ["Back", "BACK", ""]]);
  assert.equal(nodes.hb1.reactions.length, 0, "plan only");

  const wired = await run("prototype-wire", { fix: true });
  assert.equal(wired.snapshot.length, 3);
  assert.equal(nodes.hb1.reactions[0].actions[0].destinationId, "p");
  assert.equal(nodes.pb1.reactions[0].actions[0].type, "BACK");
  assert.equal(nodes.hb3.reactions.length, 1, "existing interaction kept");

  await run("restore-props", { items: wired.snapshot });
  assert.equal(nodes.hb1.reactions.length, 0);
  assert.equal(nodes.pb1.reactions.length, 0);
});

test("buttons are found by look, not only by name, also inside card instances", async () => {
  const unnamed = (id: string, label: string, extra: any = {}) => ({ id, type: "FRAME", name: "Frame 4", layoutMode: "HORIZONTAL", width: 120, height: 40, cornerRadius: 0,
    fills: [], strokes: [], children: [txt(id + "t", label)], ...extra });
  const card: any = { id: "card", type: "INSTANCE", name: "Loan Card", layoutMode: "VERTICAL", width: 328, height: 160, fills: [], strokes: [],
    children: [txt("ct1", "Home loan"), txt("ct2", "₹12,000 due"), unnamed("pay", "Pay now", { fills: [{ type: "SOLID", visible: true }] })] };
  const label: any = { id: "lab", type: "FRAME", name: "Frame 9", width: 200, height: 30, fills: [], strokes: [], children: [txt("lt", "Due date")] };
  const loans: any = { id: "l", type: "FRAME", name: "QA wire — Loans", x: 0, y: 0, width: 360, height: 800, fills: [], strokes: [], children: [card, label] };
  const payScreen: any = { id: "ps", type: "FRAME", name: "Pay now", x: 400, y: 0, width: 360, height: 800, fills: [], strokes: [], children: [{ ...unnamed("back", "Back"), name: "Back" }] };
  const nodes: Record<string, any> = { l: loans, ps: payScreen };
  const run = runtime([loans, payScreen], nodes);
  const plan = await run("prototype-wire", {});
  assert.deepEqual(plan.links.map((l: any) => [l.label, l.action, l.to]), [["Pay now", "NAVIGATE", "Pay now"], ["Back", "BACK", ""]]);
  const notes = await run("handoff-notes", {});
  assert.ok(notes.notes.some((n: any) => n.kind === "button" && n.id === "pay"), "button inside the card instance gets a note");
  assert.ok(!notes.notes.some((n: any) => n.id === "lab"), "a plain label frame is not a button");
});
