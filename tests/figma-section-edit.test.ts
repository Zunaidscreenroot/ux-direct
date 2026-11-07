/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function uiBlock(): any {
  const match = /\/\/ uxd-section-edit:start([\s\S]*?)\/\/ uxd-section-edit:end/.exec(ui);
  assert.ok(match);
  const sandbox: any = { Set, JSON, Object };
  runInNewContext(match[1] + "\nthis.diff = diffSectionStates; this.plan = sectionRevertPlan;", sandbox);
  return sandbox;
}

function runtime() {
  const page: any = { id: "0:1", type: "PAGE", children: [], selection: [] };
  const all: any[] = [];
  function make(props: any, parent: any) {
    const n: any = { visible: true, x: 0, y: 0, width: 100, height: 40, fills: [], children: [], ...props, parent };
    n.data = {}; n.getPluginData = (k: string) => n.data[k] || ""; n.setPluginData = (k: string, v: string) => { n.data[k] = v; };
    n.resize = (w: number, h: number) => { n.width = w; n.height = h; };
    n.remove = () => { n.removed = true; n.parent.children.splice(n.parent.children.indexOf(n), 1); };
    parent.children.push(n); all.push(n);
    return n;
  }
  const screen = make({ id: "s", type: "FRAME", name: "Screen", layoutMode: "VERTICAL" }, page);
  const card = make({ id: "c", type: "FRAME", name: "Card", cornerRadius: 8, paddingLeft: 12, layoutMode: "VERTICAL" }, screen);
  const title = make({ id: "t", type: "TEXT", name: "Title", characters: "Loan", fontSize: 14, fontName: { family: "Inter", style: "Regular" } }, card);
  title.getRangeAllFontNames = () => [title.fontName];
  const other = make({ id: "o", type: "FRAME", name: "Other card", cornerRadius: 8 }, screen);
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: page, root: { children: [page] }, mixed: Symbol("m"),
    viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => all.find((n) => n.id === id && !n.removed) || null,
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  const run = async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const m = posted.find((x) => x.type === "uxd-local-result");
    if (m.error) throw new Error(m.error);
    return JSON.parse(JSON.stringify(m.result));
  };
  return { run, make, card, title, other };
}

test("section edit: exact Revert from before/after state, created layers removed, neighbours proven unchanged", async () => {
  const r = runtime();
  const b = uiBlock();
  const before = await r.run("section-state", { rootIds: ["c"] });
  assert.deepEqual(Object.keys(before.siblings), ["o"]);
  // The plan: radius, padding, new text, a created badge with a child.
  r.card.cornerRadius = 16; r.card.paddingLeft = 16; r.title.characters = "Personal Loan";
  const badge = r.make({ id: "n1", type: "FRAME", name: "Badge" }, r.card); badge.setPluginData("uxdCreated", "1");
  const label = r.make({ id: "n2", type: "TEXT", name: "Badge label", characters: "Active" }, badge); label.setPluginData("uxdCreated", "1");
  const after = await r.run("section-state", { rootIds: ["c"] });
  const plan = b.plan(before, after, [{ operation: "update-node" }, { operation: "create-elements" }]);
  assert.equal(plan.snapshotSafe, true);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.diff.createdIds)), ["n1"], "only the top-level created layer");
  assert.equal(plan.diff.changedSiblings.length, 0);
  const props = plan.diff.items.map((i: any) => i.id + "." + i.prop).sort();
  assert.ok(props.includes("c.cornerRadius") && props.includes("c.paddingLeft") && props.includes("t.characters"), props.join(","));

  await r.run("delete-created", { nodeIds: plan.diff.createdIds });
  const restore = await r.run("restore-props", { items: JSON.parse(JSON.stringify(plan.diff.items)) });
  assert.equal(r.card.cornerRadius, 8);
  assert.equal(r.card.paddingLeft, 12);
  assert.equal(r.title.characters, "Loan");
  assert.ok(restore.restored >= 3);

  r.other.cornerRadius = 20;
  const changed = b.diff(before, await r.run("section-state", { rootIds: ["c"] }));
  assert.deepEqual(JSON.parse(JSON.stringify(changed.changedSiblings)), ["Other card"], "a change next to the selection is caught");
});

test("deletes, untagged layers and structural ops fall back to Figma undo", () => {
  const b = uiBlock();
  const state = (order: string[], extra: any = {}) => ({ order, nodes: Object.fromEntries(order.map((id) => [id, { name: id }])), created: [], siblings: {}, ...extra });
  assert.equal(b.plan(state(["c", "t"]), state(["c"]), [{ operation: "update-node" }]).snapshotSafe, false, "a deleted layer");
  assert.equal(b.plan(state(["c"]), state(["c", "x"]), [{ operation: "update-node" }]).snapshotSafe, false, "a new layer UX Direct did not tag");
  assert.equal(b.plan(state(["c"]), state(["c"]), [{ operation: "swap-component" }]).snapshotSafe, false, "a component swap");
  assert.equal(b.plan(state(["c"], { truncated: true }), state(["c"]), [{ operation: "update-node" }]).snapshotSafe, false, "a truncated state");
  assert.equal(b.plan(state(["c"]), state(["c"]), [{ operation: "set-fills" }]).snapshotSafe, true);
});

test("cleanup brief only for one selected section with children", async () => {
  const { sectionEditBrief } = await import("../src/figma-agent/section-edit");
  const card = { nodes: [{ id: "1", name: "Loan Card", type: "FRAME", children: [{ id: "2", type: "TEXT" }] }] };
  assert.match(sectionEditBrief("make this card cleaner", card), /SECTION EDIT \(cleanup\)[\s\S]*never delete nodes/);
  assert.equal(sectionEditBrief("make the title blue", card), "");
  assert.equal(sectionEditBrief("make it cleaner", { nodes: [card.nodes[0], card.nodes[0]] }), "");
});
