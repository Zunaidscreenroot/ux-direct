/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function region(name: string, expose: string): any {
  const match = new RegExp("// " + name + ":start([\\s\\S]*?)// " + name + ":end").exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.out = " + expose + ";", sandbox);
  return sandbox.out;
}
const plain = (v: any) => JSON.parse(JSON.stringify(v));

test("learn prompts route to the learn task", () => {
  const classify = region("uxd-quick-task-classifier", "classifyQuickTask");
  assert.deepEqual(plain(classify("learn from my edits", { selectionTypes: [] })), { kind: "learn", preview: false });
  assert.deepEqual(plain(classify("what did I change?", { selectionTypes: [] })), { kind: "learn", preview: true });
  assert.deepEqual(plain(classify("meri changes se seekho", { selectionTypes: ["FRAME"] })), { kind: "learn", preview: false });
  assert.notEqual(classify("revert the learned changes", { selectionTypes: [] }).kind, "learn");
});

test("learned rules merge into the designer's own rules, one line per subject", () => {
  const { merge } = region("uxd-learn", "{ merge: mergeLearnedRules }");
  const first = merge("spacing 4/8/16, radius 8/16", [
    { role: "button", prop: "radius", from: 8, to: 12, layers: 3 },
    { role: "text", textRole: "Card title", prop: "size", from: 14, to: 16, layers: 5 },
  ]);
  assert.equal(first.text, "spacing 4/8/16, radius 8/16\n\nLearned from your edits:\n- Button corner radius: use 12 px (not 8 px)\n- Card title size: use 16 px (not 14 px)");
  const second = merge(first.text, [{ role: "button", prop: "radius", from: 12, to: 16, layers: 2 }, { role: "frame", prop: "fill", from: "#FFFFFF", to: "#F8FAFC", layers: 1 }]);
  assert.equal(second.text, "spacing 4/8/16, radius 8/16\n\nLearned from your edits:\n- Card title size: use 16 px (not 14 px)\n- Button corner radius: use 16 px (not 12 px)\n- Container fill #FFFFFF: use #F8FAFC (not #FFFFFF)");
  assert.equal(second.added.length, 2);
});

function decorate(n: any, parent: any): any {
  const data: Record<string, string> = {};
  n.parent = parent; n.visible = true;
  n.getPluginData = (k: string) => data[k] || ""; n.setPluginData = (k: string, v: string) => { data[k] = v; };
  n.findAll = function (t: (x: any) => boolean) {
    const out: any[] = [];
    (function walk(x: any) { (x.children || []).forEach((c: any) => { if (t(c)) out.push(c); walk(c); }); })(n);
    return out;
  };
  (n.children || []).forEach((c: any) => decorate(c, n));
  return n;
}
function runtime(page: any[], nodes: Record<string, any>) {
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: page, selection: [], findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
  };
  page.forEach((s) => decorate(s, figma.currentPage));
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  return async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const msg = posted.find((m) => m.type === "uxd-local-result");
    if (msg.error) throw new Error(msg.error);
    return plain(msg.result);
  };
}

test("baseline then diff finds the designer's edits, commits once, and restores", async () => {
  const solid = (r: number, g: number, b: number) => [{ type: "SOLID", visible: true, color: { r, g, b } }];
  const label: any = { id: "t1", type: "TEXT", name: "Pay now", characters: "Pay now", fontSize: 14, fontName: { family: "Inter", style: "Regular" }, fills: solid(1, 1, 1) };
  const btn: any = { id: "b1", type: "FRAME", name: "Primary button", layoutMode: "HORIZONTAL", width: 200, height: 44, cornerRadius: 8, itemSpacing: 8,
    paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, fills: solid(0, 0, 1), strokes: [], children: [label] };
  const body: any = { id: "t2", type: "TEXT", name: "Body", characters: "Your EMI is due", fontSize: 14, fontName: { family: "Inter", style: "Regular" }, fills: solid(0, 0, 0) };
  const screen: any = { id: "s1", type: "FRAME", name: "Home", width: 360, height: 800, fills: solid(1, 1, 1), strokes: [], children: [btn, body] };
  const nodes: Record<string, any> = { s1: screen, b1: btn, t1: label, t2: body };
  const run = runtime([screen], nodes);
  Object.values(nodes).forEach((n: any) => n.setPluginData("uxdCreated", "1"));

  assert.equal((await run("learn-baseline", { nodeIds: ["s1"] })).stored, 4);
  assert.equal((await run("learn-corrections", {})).changes.length, 0);

  assert.equal(JSON.parse(body.getPluginData("uxdBaseline")).textRole, "body text");
  assert.equal(JSON.parse(label.getPluginData("uxdBaseline")).textRole, "Button label");
  btn.cornerRadius = 12; btn.height = 48; body.fontSize = 16; label.fontName = { family: "Inter", style: "Semi Bold" };
  const found = await run("learn-corrections", {});
  assert.equal(found.edited, 3);
  assert.deepEqual(found.changes.map((c: any) => [c.role, c.prop, c.from, c.to]).sort(), [
    ["button", "height", 44, 48], ["button", "radius", 8, 12], ["text", "size", 14, 16], ["text", "weight", "Regular", "Semi Bold"],
  ]);

  const committed = await run("learn-corrections", { commit: true });
  assert.equal(Object.keys(committed.previous).length, 3);
  assert.equal((await run("learn-corrections", {})).changes.length, 0, "an edit is learned once");

  await run("learn-corrections", { restore: committed.previous });
  assert.equal((await run("learn-corrections", {})).changes.length, 4, "Revert brings the baseline back");
});
