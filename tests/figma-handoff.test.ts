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
  assert.deepEqual(classify("create a journey to pay an overdue EMI", { selectionTypes: [] }), { kind: "journey-create" });
  assert.deepEqual(classify("add the missing states to this flow", two), { kind: "flow-states" });
  assert.deepEqual(classify("create a journey to pay overdue EMI from this screen", one), { kind: "journey-create", fromSelection: true });
  assert.notEqual(classify("improve this screen", one)?.kind, "journey-create");
  assert.deepEqual(classify("design the next step", one), { kind: "journey-next" });
  assert.notEqual(classify("create a flow variation", two)?.kind, "journey-create");
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

test("prototype Revert works when Figma normalises the reactions it read back", async () => {
  const home: any = { id: "h", type: "FRAME", name: "Home", x: 0, y: 0, width: 360, height: 800, fills: [], strokes: [], children: [button("hb", "Continue")] };
  const next: any = { id: "n", type: "FRAME", name: "Next step", x: 400, y: 0, width: 360, height: 800, fills: [], strokes: [], children: [] };
  const nodes: Record<string, any> = { h: home, n: next };
  const run = runtime([home, next], nodes);
  const hb = home.children[0]; nodes.hb = hb;
  const wired = await run("prototype-wire", { fix: true });
  // Figma later reports the same link with the deprecated "action" field and filled-in defaults.
  hb.reactions = hb.reactions.map((r: any) => ({ ...r, action: r.actions[0], actions: [{ ...r.actions[0], resetVideoPosition: false }] }));
  const restored = await run("restore-props", { items: wired.snapshot });
  assert.equal(restored.restored, 1);
  assert.equal(hb.reactions.length, 0);
});

test("Skip in an onboarding run goes past the other Skip screens to the first screen without one", async () => {
  const s = (id: string, name: string, x: number, kids: any[]): any => ({ id, type: "FRAME", name, x, y: 0, width: 360, height: 800, children: kids });
  const one = s("o1", "Intro 1", 0, [button("k1", "Skip"), button("n1", "Next")]);
  const two = s("o2", "Intro 2", 400, [button("k2", "Skip"), button("n2", "Next")]);
  const home = s("hm", "Dashboard", 800, [button("x", "Profile")]);
  const nodes: Record<string, any> = { o1: one, o2: two, hm: home };
  const run = runtime([home, two, one], nodes);
  const plan = await run("prototype-wire", {});
  const links = plan.links.map((l: any) => [l.screen, l.label, l.to]);
  assert.deepEqual(links.filter((l: any) => l[1] === "Skip"), [["Intro 1", "Skip", "Dashboard"], ["Intro 2", "Skip", "Dashboard"]]);
  assert.deepEqual(links.filter((l: any) => l[1] === "Next"), [["Intro 1", "Next", "Intro 2"], ["Intro 2", "Next", "Dashboard"]]);
});

test("Skip skips the whole named run, even run screens without a Skip of their own", async () => {
  const s = (id: string, name: string, x: number, kids: any[]): any => ({ id, type: "FRAME", name, x, y: 0, width: 360, height: 800, children: kids });
  const one = s("a1", "Onboarding 1", 0, [button("a1s", "Skip"), button("a1n", "Next")]);
  const two = s("a2", "Onboarding 2", 400, [button("a2p", "Previous"), button("a2f", "Finish")]);
  const home = s("ah", "Home", 800, [button("ahx", "Profile")]);
  const run = runtime([one, two, home], { a1: one, a2: two, ah: home });
  const plan = await run("prototype-wire", {});
  const skip = plan.links.find((l: any) => l.label === "Skip");
  assert.equal(skip.to, "Home");
});

test("a journey wires Back icons, skips the failure state going forward, Retry goes back, Done returns to the start, and the flow gets a start", async () => {
  const backIcon = (id: string) => ({ id, type: "INSTANCE", name: "Icon / arrow-left", width: 24, height: 24, children: [{ id: id + "v", type: "VECTOR", name: "Vector", width: 16, height: 16 }] });
  const s1: any = { id: "s1", type: "FRAME", name: "My loans", x: 0, y: 0, width: 360, height: 800, children: [button("b1", "View details")] };
  const s2: any = { id: "s2", type: "FRAME", name: "Loan details", x: 400, y: 0, width: 360, height: 800, children: [backIcon("i2"), button("b2", "Pay ₹8,450")] };
  const s3: any = { id: "s3", type: "FRAME", name: "Payment successful", x: 800, y: 0, width: 360, height: 800, children: [button("b3", "Done")] };
  const s4: any = { id: "s4", type: "FRAME", name: "Payment failed", x: 1200, y: 0, width: 360, height: 800, children: [button("b4", "Retry"), button("b5", "Go to home", { name: "Secondary button" })] };
  const nodes: Record<string, any> = { s1, s2, s3, s4 };
  const run = runtime([s3, s1, s4, s2], nodes);
  const page: any = (s1 as any).parent;
  page.flowStartingPoints = [];
  const plan = await run("prototype-wire", {});
  const map = Object.fromEntries(plan.links.map((l: any) => [l.label, l.action === "BACK" ? "back" : l.to]));
  assert.equal(map["Icon / arrow-left"], "back", "app bar back icon");
  assert.equal(map["Pay ₹8,450"], "Payment successful", "main button moves on, never into the failure state");
  assert.equal(map["Done"], "My loans", "the end returns to the start");
  assert.equal(map["Retry"], "Loan details", "retry opens the step that failed");
  assert.equal(map["Go to home"], "My loans");
  assert.deepEqual(plan.deadEnds, []);
  const wired = await run("prototype-wire", { fix: true });
  assert.equal(page.flowStartingPoints[0].nodeId, "s1");
  assert.equal(wired.flowStart, "My loans");
});

test("a journey's shared title words do not decide where a button goes", async () => {
  const s1: any = { id: "j1", type: "FRAME", name: "Pay EMI / 1 · My loans", x: 0, y: 0, width: 360, height: 800, children: [button("c1", "Pay EMI")] };
  const s2: any = { id: "j2", type: "FRAME", name: "Pay EMI / 2 · Choose amount", x: 400, y: 0, width: 360, height: 800, children: [button("c2", "Continue")] };
  const s3: any = { id: "j3", type: "FRAME", name: "Pay EMI / 3 · Payment successful", x: 800, y: 0, width: 360, height: 800, children: [button("c3", "Done")] };
  const s4: any = { id: "j4", type: "FRAME", name: "Pay EMI / 4 · Payment failed", x: 1200, y: 0, width: 360, height: 800, children: [button("c4", "Retry")] };
  const run = runtime([s1, s2, s3, s4], { j1: s1, j2: s2, j3: s3, j4: s4 });
  const plan = await run("prototype-wire", {});
  const map = Object.fromEntries(plan.links.map((l: any) => [l.label, l.action === "BACK" ? "back" : l.to]));
  assert.equal(map["Pay EMI"], "Pay EMI / 2 · Choose amount");
  assert.equal(map["Continue"], "Pay EMI / 3 · Payment successful");
  assert.equal(map["Done"], "Pay EMI / 1 · My loans");
  assert.equal(map["Retry"], "Pay EMI / 2 · Choose amount", "retry opens the step that failed");
});

test("journey wiring: links inside instances fall back to the instance, success never leads to failure, Back to X, the true entry gets the start", async () => {
  const card = (id: string) => ({ id, type: "INSTANCE", name: "Loan card", width: 328, height: 120, children: [txt(id + "a", "Personal Loan"), button(id + "b", "Pay now")] });
  const f1: any = { id: "e1", type: "FRAME", name: "Manage loans", x: 0, y: 200, width: 360, height: 800, children: [card("k1")] };
  const f2: any = { id: "e2", type: "FRAME", name: "Payment method", x: 400, y: 0, width: 360, height: 800, children: [button("m1", "Pay ₹8,450")] };
  const f3: any = { id: "e3", type: "FRAME", name: "Flow 2", x: 800, y: 0, width: 360, height: 800, children: [
    { id: "h3", type: "TEXT", name: "Title", characters: "Payment successful", fontSize: 24 }, button("d3", "Download receipt"), button("b3", "Back to loans")] };
  const f4: any = { id: "e4", type: "FRAME", name: "Payment failed", x: 1200, y: 0, width: 360, height: 800, children: [button("r4", "Retry")] };
  const nodes: Record<string, any> = { e1: f1, e2: f2, e3: f3, e4: f4 };
  const run = runtime([f1, f2, f3, f4], nodes);
  const inner = f1.children[0].children[1];
  // Figma accepts the write on a layer inside an instance but does not keep it.
  inner.setReactionsAsync = async () => { inner.reactions = []; };
  const page: any = f1.parent;
  page.flowStartingPoints = [{ nodeId: "e3", name: "Flow 2" }];
  const wired = await run("prototype-wire", { fix: true });
  const map = Object.fromEntries(wired.links.map((l: any) => [l.label, l.action === "BACK" ? "back" : l.to]));
  assert.equal(map["Pay now"], "Payment method");
  assert.equal(f1.children[0].reactions[0].actions[0].destinationId, "e2", "the card instance carries the link");
  assert.notEqual(map["Download receipt"], "Payment failed", "the end never opens the failure state");
  assert.equal(map["Back to loans"], "Manage loans");
  assert.equal(map["Retry"], "Payment method");
  assert.equal(wired.entry, "Manage loans");
  assert.deepEqual(page.flowStartingPoints.map((f: any) => f.nodeId), ["e1"], "the start moves to the true entry");
});
