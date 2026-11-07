/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function wantsPolish(): (prompt: string, options?: any) => boolean {
  const match = /\/\/ uxd-claude-polish-ui:start([\s\S]*?)\/\/ uxd-claude-polish-ui:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = uxdWantsPolish;", sandbox);
  return sandbox.fn;
}

test("plain improve prompts take the Claude-style polish path; redesigns, restyles and batches do not", () => {
  const wants = wantsPolish();
  for (const p of ["improve this screen", "polish this", "make this screen better", "refine the UI", "isko behtar karo", "clean up this screen"]) {
    assert.equal(wants(p), true, p);
  }
  for (const p of ["redesign this screen", "improve it with a dark theme", "make it more modern", "create 3 variations", "improve the copy",
    "add an empty state", "rebuild from scratch", "make it look like Apple"]) {
    assert.equal(wants(p), false, p);
  }
  assert.equal(wants("improve this screen", { variation: "bold" }), false);
  assert.equal(wants("improve this screen", { sourceId: "1:2" }), false);
});

let nextId = 100;
function deepClone(node: any, parent: any): any {
  const copy: any = { ...node, id: String(nextId++), parent };
  if (Array.isArray(node.children)) copy.children = node.children.map((c: any) => deepClone(c, copy));
  attach(copy);
  return copy;
}
function attach(n: any) {
  n.findAll = function (t: (x: any) => boolean) {
    const out: any[] = [];
    (function walk(x: any) { (x.children || []).forEach((c: any) => { if (t(c)) out.push(c); walk(c); }); })(this);
    return out;
  };
  n.clone = function () { return deepClone(this, null); };
  n.setPluginData = function (k: string, v: string) { this.plugin = { ...(this.plugin || {}), [k]: v }; };
  n.getPluginData = function (k: string) { return (this.plugin || {})[k] || ""; };
  n.remove = function () { this.removed = true; if (this.parent && this.parent.children) this.parent.children = this.parent.children.filter((c: any) => c !== this); };
}

function runtime(nodes: Record<string, any>) {
  const posted: any[] = [];
  const page: any = { id: "0:1", type: "PAGE", children: [] as any[], selection: [] as any[], findOne: () => null };
  page.appendChild = (n: any) => { page.children.push(n); n.parent = page; };
  page.insertChild = (i: number, n: any) => { page.children.splice(i, 0, n); n.parent = page; };
  const register = (n: any) => { nodes[n.id] = n; (n.children || []).forEach(register); };
  Object.values(nodes).forEach((n: any) => { attach(n); (n.children || []).forEach((c: any) => { c.parent = n; }); });
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: page, root: { children: [] }, mixed: Symbol("m"),
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  const run = async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const msg = posted.find((m) => m.type === "uxd-local-result");
    if (msg.error) throw new Error(msg.error);
    const result = msg.result;
    if (result && result.id && nodes[result.id] === undefined) {
      const created = page.children.find((c: any) => c.id === result.id);
      if (created) register(created);
    }
    return JSON.parse(JSON.stringify(result));
  };
  return { figma, run, page };
}

const text = (id: string, characters: string, extra: any = {}) => ({ id, type: "TEXT", name: characters, characters, visible: true, width: 80, height: 16, x: 0, y: 0, ...extra });
const cardSet = { id: "set", type: "COMPONENT_SET", name: "Loan Card" };
const cardMain = { id: "main", type: "COMPONENT", name: "Type 2", parent: cardSet };
function card(id: string, withAlert: boolean) {
  const header = { id: id + "h", type: "FRAME", name: "Frame 1", layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 16, visible: true, x: 0, y: 0, width: 320, height: 144,
    children: [text(id + "t1", "Personal Loan"), text(id + "t2", "₹12,000")] };
  const alert = { id: id + "a", type: "FRAME", name: "Frame 2", layoutMode: "HORIZONTAL", itemSpacing: 8, paddingTop: 36, paddingLeft: 16, visible: true, x: 0, y: 120, width: 320, height: 78,
    children: [text(id + "t3", "Pay your dues"), text(id + "t4", "Pay now")] };
  return { id, type: "INSTANCE", name: "Loan Card", mainComponent: cardMain, layoutMode: "VERTICAL", itemSpacing: withAlert ? -24 : 0, visible: true,
    x: 20, y: 0, width: 320, height: withAlert ? 198 : 144, children: withAlert ? [header, alert] : [header] };
}
function screen() {
  const list = { id: "list", type: "FRAME", name: "Frame 2095586997", layoutMode: "VERTICAL", itemSpacing: 16, visible: true, x: 0, y: 105, width: 360, height: 600,
    children: [card("c1", false), card("c2", true), card("c3", true)] };
  const root = { id: "root", type: "FRAME", name: "15", layoutMode: "VERTICAL", itemSpacing: 0, visible: true, x: 0, y: 0, width: 360, height: 800, children: [list] };
  return { root, list };
}

test("a component-built screen is polished on a copy: overlaps removed, roles named, content and height kept", async () => {
  const { root, list } = screen();
  const nodes: Record<string, any> = { root, list };
  const { run, page, figma } = runtime(nodes);
  page.children.push(root); (root as any).parent = page;

  const assessed = await run("claude-polish", { sourceId: "root", assessOnly: true });
  assert.equal(assessed.eligible, true);
  assert.equal(assessed.assessment.instanceShare, 100);
  assert.deepEqual(assessed.assessment.repeated, ["3× Loan Card"]);
  assert.equal(page.children.length, 1, "assessing never writes");

  const made = await run("claude-polish", { sourceId: "root", x: 460, y: 0 });
  assert.equal(made.eligible, true);
  const copy = nodes[made.id];
  assert.ok(copy && copy !== root);
  assert.equal(copy.getPluginData("uxdCreated"), "1", "Revert may delete it");
  assert.equal(copy.x, 460);
  assert.equal(copy.name, "15 · improved");
  assert.equal(copy.children[0].name, "Loan Card list");
  assert.equal(made.negativeGaps, 2);
  const copiedCard = copy.children[0].children[1];
  assert.equal(copiedCard.itemSpacing, 0);
  assert.equal(copiedCard.children[1].paddingTop, 12, "the alert's padding absorbs the old overlap");
  assert.equal(list.children[1].itemSpacing, -24, "the source is untouched");
  assert.equal(list.name, "Frame 2095586997");
  assert.deepEqual(JSON.parse(JSON.stringify(figma.currentPage.selection.map((n: any) => n.id))), [made.id]);

  const check = await run("claude-self-check", { sourceId: "root", outputId: made.id });
  assert.equal(check.passed, true);
  const byName = Object.fromEntries(check.checks.map((c: any) => [c.name, c.pass]));
  assert.equal(byName["Content kept"], true);
  assert.equal(byName["No overlap"], true);
  assert.equal(byName["Components reused"], true);

  copy.children[0].children[0].children[0].children[1].characters = "₹99";
  const broken = await run("claude-self-check", { sourceId: "root", outputId: made.id });
  assert.equal(broken.passed, false, "a changed source text fails the hard gate");
  assert.deepEqual(broken.invented, ["₹99"]);
});

test("a free-positioned screen with overlapping layers is not polished (it goes to the rebuild)", async () => {
  const box = (id: string, y: number) => ({ id, type: "FRAME", name: "Frame " + id, visible: true, x: 0, y, width: 300, height: 100,
    children: [text(id + "a", "Label " + id, { y: 0 }), text(id + "b", "Value " + id, { y: 0 })] });
  const root = { id: "r2", type: "FRAME", name: "Old screen", visible: true, x: 0, y: 0, width: 360, height: 800,
    children: [box("b1", 0), box("b2", 50), box("b3", 90), box("b4", 120)] };
  const nodes: Record<string, any> = { r2: root };
  const { run, page } = runtime(nodes);
  page.children.push(root);
  const result = await run("claude-polish", { sourceId: "r2", x: 500, y: 0 });
  assert.equal(result.eligible, false);
  assert.ok(result.assessment.reasons.length >= 1);
  assert.equal(page.children.length, 1, "nothing was created");
});
