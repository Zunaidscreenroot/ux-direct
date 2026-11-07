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

test("detached prompts route to the rescue task", () => {
  const classify = classifier();
  const one = { selectionTypes: ["FRAME"] };
  assert.deepEqual(classify("find detached components", one), { kind: "detached", fix: false });
  assert.deepEqual(classify("relink detached instances", one), { kind: "detached", fix: true });
  assert.deepEqual(classify("detached components ko reattach karo", one), { kind: "detached", fix: true });
  assert.equal(classify("find detached components", { selectionTypes: [] }), null);
});

let seq = 0;
function decorate(n: any, nodes: Record<string, any>): any {
  n.children = n.children || (["FRAME", "INSTANCE", "COMPONENT"].includes(n.type) ? [] : undefined);
  n.pluginData = n.pluginData || {};
  n.getPluginData = (k: string) => n.pluginData[k] || "";
  n.setPluginData = (k: string, v: string) => { n.pluginData[k] = v; };
  n.findAll = function (t: (x: any) => boolean) {
    const out: any[] = [];
    (function walk(x: any) { (x.children || []).forEach((c: any) => { if (t(c)) out.push(c); walk(c); }); })(n);
    return out;
  };
  n.insertChild = (i: number, c: any) => { n.children.splice(i, 0, c); c.parent = n; };
  n.appendChild = (c: any) => { n.children.push(c); c.parent = n; };
  n.remove = () => { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.removed = true; };
  n.resize = (w: number, h: number) => { n.width = w; n.height = h; };
  (n.children || []).forEach((c: any) => { c.parent = n; decorate(c, nodes); });
  nodes[n.id] = n;
  return n;
}
function deepCopy(n: any, nodes: Record<string, any>, type?: string): any {
  const c: any = { id: "i" + (++seq), type: type || n.type, name: n.name, characters: n.characters, visible: true, width: n.width, height: n.height,
    children: n.children ? n.children.map((k: any) => deepCopy(k, nodes)) : undefined };
  return decorate(c, nodes);
}

function runtime(nodes: Record<string, any>, selection: any[]) {
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: [], selection, findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
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

test("detached copies are reported, relinked with text overrides, and Revert data is exact", async () => {
  const nodes: Record<string, any> = {};
  const component = decorate({ id: "c1", type: "COMPONENT", name: "Button", width: 120, height: 40,
    children: [{ id: "c1t", type: "TEXT", name: "Label", characters: "Button", visible: true }] }, nodes);
  component.createInstance = () => deepCopy(component, nodes, "INSTANCE");
  const good = { id: "d1", type: "FRAME", name: "Pay button", detachedInfo: { type: "local", componentId: "c1" }, visible: true, width: 160, height: 48, x: 10, y: 20,
    children: [{ id: "d1t", type: "TEXT", name: "Label", characters: "Pay now", visible: true }] };
  const extra = { id: "d2", type: "FRAME", name: "Odd button", detachedInfo: { type: "local", componentId: "c1" }, visible: true, width: 120, height: 40, x: 0, y: 80,
    children: [{ id: "d2a", type: "TEXT", name: "Label", characters: "Go", visible: true }, { id: "d2b", type: "TEXT", name: "Hint", characters: "Fast", visible: true }] };
  const gone = { id: "d3", type: "FRAME", name: "Old chip", detachedInfo: { type: "local", componentId: "missing" }, visible: true, width: 60, height: 24, children: [] };
  const screen = decorate({ id: "s", type: "FRAME", name: "Home", layoutMode: "NONE", visible: true, width: 360, height: 800, children: [good, extra, gone] }, nodes);
  const run = runtime(nodes, [screen]);

  const check = await run("detached-rescue", {});
  assert.deepEqual(check.results.map((r: any) => [r.name, r.status]), [["Pay button", "ready"], ["Odd button", "skipped"], ["Old chip", "skipped"]]);
  assert.match(check.results[1].reason, /no slot for: Fast/);
  assert.equal(screen.children.length, 3, "check does not change the file");

  const fixed = await run("detached-rescue", { fix: true });
  assert.equal(fixed.createdIds.length, 1);
  const inst = nodes[fixed.createdIds[0]];
  assert.equal(inst.type, "INSTANCE");
  assert.equal(inst.name, "Pay button");
  assert.equal(inst.children[0].characters, "Pay now");
  assert.deepEqual([inst.x, inst.y, inst.width, inst.height], [10, 20, 160, 48]);
  assert.equal(screen.children.indexOf(inst), 0, "instance takes the copy's place");
  assert.equal(nodes.d1.visible, false);
  assert.deepEqual(fixed.restore, [{ id: "d1", prop: "visible", before: true, after: false }]);
  assert.equal(inst.pluginData.uxdCreated, "1");
});
