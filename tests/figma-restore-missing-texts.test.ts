/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function runtime(nodes: Record<string, any>) {
  const posted: any[] = [];
  const findAll = function (this: any, t: (n: any) => boolean) {
    const out: any[] = [];
    (function walk(n: any) { (n.children || []).forEach((c: any) => { if (t(c)) out.push(c); walk(c); }); })(this);
    return out;
  };
  let seq = 0;
  const appendChild = function (this: any, c: any) { this.children.push(c); c.parent = this; };
  const decorate = (n: any) => {
    n.findAll = findAll; n.appendChild = appendChild;
    n.pluginData = n.pluginData || {};
    n.getPluginData = (k: string) => n.pluginData[k] || ""; n.setPluginData = (k: string, v: string) => { n.pluginData[k] = v; };
    n.clone = () => { const c = decorate({ ...n, id: "clone" + (++seq), parent: null, pluginData: {}, children: undefined }); nodes[c.id] = c; return c; };
    (n.children || []).forEach((c: any) => { c.parent = n; decorate(c); });
    return n;
  };
  Object.values(nodes).forEach(decorate);
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: [], selection: [], findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  return async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const msg = posted.find((m) => m.type === "uxd-local-result");
    if (msg.error) throw new Error(msg.error);
    return JSON.parse(JSON.stringify(msg.result));
  };
}

const text = (id: string, characters: string, x = 0, y = 0) => ({ id, type: "TEXT", name: characters, characters, x, y, visible: true,
  absoluteTransform: [[1, 0, x], [0, 1, y]] });

test("restore-missing-texts clones exact source texts into the matching created parent", async () => {
  const src: any = { id: "src", type: "FRAME", name: "Home", layoutMode: "NONE", absoluteTransform: [[1, 0, 0], [0, 1, 0]], children: [
    { id: "card", type: "FRAME", name: "Loan card", layoutMode: "VERTICAL", children: [text("t1", "Next EMI due"), text("t2", "Pay now")] },
    text("t3", "Need help?", 20, 700),
  ] };
  const outCard: any = { id: "ocard", type: "FRAME", name: "Loan card", layoutMode: "VERTICAL", children: [text("o1", "Pay now")] };
  const out: any = { id: "out", type: "FRAME", name: "Home v2", layoutMode: "NONE", pluginData: { uxdCreated: "1" }, children: [outCard] };
  const nodes: Record<string, any> = { src, out, ocard: outCard };
  const run = runtime(nodes);

  const result = await run("restore-missing-texts", { sourceRootId: "src", outputRootId: "out", texts: ["next emi due", "need help", "not in source"] });
  assert.deepEqual(result.restored.map((r: any) => [r.text, r.parent]), [["next emi due", "Loan card"], ["need help", "Home v2"]]);
  assert.deepEqual(result.skipped, ["not in source"]);
  assert.deepEqual(outCard.children.map((c: any) => c.characters), ["Pay now", "Next EMI due"]);
  const help = out.children.find((c: any) => c.characters === "Need help?");
  assert.equal(help.x, 20); assert.equal(help.y, 700);
  assert.equal(help.pluginData.uxdCreated, "1", "Revert removes restored layers");
});

test("restore-missing-texts never edits a frame UX Direct did not create", async () => {
  const src: any = { id: "src", type: "FRAME", name: "A", children: [text("t1", "Hello")] };
  const out: any = { id: "out", type: "FRAME", name: "B", children: [] };
  const run = runtime({ src, out });
  await assert.rejects(run("restore-missing-texts", { sourceRootId: "src", outputRootId: "out", texts: ["hello"] }), /not created by UX Direct/);
});

test("lint gate restores 1-5 missing texts and lints again; icon task drops value-only labels", () => {
  const gate = /async function runStructuralLintGate[\s\S]*?\n    }\n/.exec(ui)![0];
  assert.match(gate, /missing\.length >= 1 && missing\.length <= 5/);
  assert.match(gate, /localTask\("restore-missing-texts"/);
  assert.match(gate, /partial !== true/);
  assert.match(ui, /targets = targets\.filter\(function \(t\) \{ return !t\.label \|\| \/\\p\{L\}\/u\.test/);
});

test("restore-missing-texts puts a card text beside its card neighbour, never loose at the screen root", async () => {
  const src: any = { id: "src", type: "FRAME", name: "Home", layoutMode: "NONE", absoluteTransform: [[1, 0, 0], [0, 1, 0]], children: [
    { id: "c3", type: "FRAME", name: "Frame 12", layoutMode: "VERTICAL", children: [text("t1", "Overdue"), text("t2", "Delinquent")] },
  ] };
  const box: any = { id: "obox", type: "FRAME", name: "Stats", layoutMode: "VERTICAL", children: [text("o1", "Overdue")] };
  const out: any = { id: "out", type: "FRAME", name: "Home v2", layoutMode: "VERTICAL", pluginData: { uxdCreated: "1" }, children: [box] };
  const nodes: Record<string, any> = { src, out, obox: box };
  Object.values(nodes).forEach((n: any) => { n.insertChild = function (this: any, i: number, c: any) { this.children.splice(i, 0, c); c.parent = this; }; });
  box.insertChild = function (i: number, c: any) { box.children.splice(i, 0, c); c.parent = box; };
  const run = runtime(nodes);
  const result = await run("restore-missing-texts", { sourceRootId: "src", outputRootId: "out", texts: ["delinquent"] });
  assert.deepEqual(result.restored.map((r: any) => r.parent), ["Stats"]);
  assert.deepEqual(box.children.map((c: any) => c.characters), ["Overdue", "Delinquent"]);
  assert.equal(out.children.length, 1, "nothing added at the root");
});
