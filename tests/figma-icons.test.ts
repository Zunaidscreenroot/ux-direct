/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { handleIconTask, pickIconForLabel, sanitizeIconSvg, iconNameFromQuery } from "../src/figma-agent/icons";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
const LUCIDE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/></g></svg>';

function classifier(): (prompt: string, ctx: any) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = classifyQuickTask;", sandbox);
  return (prompt, ctx) => { const out = sandbox.fn(prompt, ctx); return out === null ? null : JSON.parse(JSON.stringify(out)); };
}

test("icon prompts route to the icon task, colour/size edits do not", () => {
  const classify = classifier();
  const frame = { selectionTypes: ["FRAME"] };
  assert.deepEqual(classify("add a wallet icon", frame), { kind: "icon", mode: "named", query: "wallet" });
  assert.deepEqual(classify("replace the icon with bell", { selectionTypes: ["VECTOR"] }), { kind: "icon", mode: "named", query: "bell" });
  assert.deepEqual(classify("bank icon lagao", frame), { kind: "icon", mode: "named", query: "bank" });
  for (const prompt of ["add icons to these buttons", "add relevant icons", "icons lagao", "add matching icons to the menu"]) {
    assert.deepEqual(classify(prompt, frame), { kind: "icon", mode: "auto" }, prompt);
  }
  for (const prompt of ["make the icon white", "make icons bigger", "remove the icon", "change icon colour to blue"]) {
    assert.notEqual(classify(prompt, frame)?.kind, "icon", prompt);
  }
  assert.notEqual(classify("add a wallet icon", { selectionTypes: [] })?.kind, "icon");
});

test("labels map to icons deterministically and SVGs are sanitized", () => {
  assert.equal(pickIconForLabel("Pay now"), "credit-card");
  assert.equal(pickIconForLabel("Send money"), "send");
  assert.equal(pickIconForLabel("Download statement"), "download");
  assert.equal(pickIconForLabel("Apply for loan"), "hand-coins");
  assert.equal(pickIconForLabel("Total outstanding"), null);
  assert.equal(pickIconForLabel("Due"), "calendar");
  assert.equal(iconNameFromQuery("Credit Card icon"), "credit-card");
  assert.equal(sanitizeIconSvg(LUCIDE), LUCIDE);
  assert.equal(sanitizeIconSvg('<svg><script>alert(1)</script></svg>'), null);
  assert.equal(sanitizeIconSvg('<svg onload="x()"><path d="M0 0"/></svg>'), null);
  assert.equal(sanitizeIconSvg('<svg><image href="http://x"/></svg>'), null);
  assert.equal(sanitizeIconSvg('<svg><path style="fill:url(#a)" d="M0"/></svg>'), null);
});

test("icon route resolves names, falls back to label map and search, never guesses for unknown labels", async () => {
  const hits: string[] = [];
  const fetcher = async (url: string) => {
    hits.push(url);
    const ok = /\/lucide\/(credit-card|bell|landmark)\.svg/.test(url);
    if (url.includes("/search?")) return { ok: true, status: 200, text: async () => "", json: async () => ({ icons: ["lucide:landmark"] }) };
    return { ok, status: ok ? 200 : 404, text: async () => (ok ? LUCIDE : "404"), json: async () => ({}) };
  };
  const req = (body: unknown) => new Request("https://x.test/api/assistant/figma-agent/icon", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const named = await (await handleIconTask(req({ queries: ["bell", "Pay now", "bank building"] }), fetcher)).json() as any;
  assert.equal(named.ok, true);
  assert.deepEqual(named.icons.map((i: any) => i.name), ["bell", "credit-card", "landmark"]);
  const labels = await (await handleIconTask(req({ labels: ["Pay now", "Total outstanding", "Pay now"] }), fetcher)).json() as any;
  assert.deepEqual(labels.icons.map((i: any) => i.name), ["credit-card", null, "credit-card"]);
  assert.equal(hits.filter((u) => u.includes("credit-card")).length, 2, "one fetch per distinct icon per request");
  const none = await handleIconTask(req({ labels: ["Total"] }), fetcher);
  assert.equal(none.status, 404);
  assert.equal((await handleIconTask(req({}), fetcher)).status, 400);
});

function makeRuntime(nodes: Record<string, any>) {
  const posted: any[] = [];
  const created: any[] = [];
  let seq = 0;
  const kids = (n: any) => n.children || [];
  const findAll = function (this: any, test: (n: any) => boolean) {
    const out: any[] = [];
    (function walk(n: any) { kids(n).forEach((c: any) => { if (test(c)) out.push(c); walk(c); }); })(this);
    return out;
  };
  Object.values(nodes).forEach((n: any) => {
    n.findAll = findAll;
    n.insertChild = function (i: number, c: any) { c.parent = this; this.children.splice(i, 0, c); };
    n.appendChild = function (c: any) { c.parent = this; this.children.push(c); };
    (n.children || []).forEach((c: any) => { c.parent = n; });
  });
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: { id: "0:1", type: "PAGE", children: [], selection: [], findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async (id: string) => nodes[id] || null,
    createNodeFromSvg(svg: string) {
      assert.ok(svg.startsWith("<svg"));
      const vec = { id: "v" + (++seq), type: "VECTOR", strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], fills: [], width: 20, height: 14 };
      const frame: any = { id: "icon" + seq, type: "FRAME", name: "svg", width: 24, height: 24, x: 0, y: 0, fills: [], children: [vec], findAll,
        data: {} as Record<string, string>, setPluginData(k: string, v: string) { this.data[k] = v; }, getPluginData(k: string) { return this.data[k] || ""; },
        rescale(f: number) { this.width *= f; this.height *= f; }, resize(w: number, h: number) { this.width = w; this.height = h; }, remove() { this.removed = true; } };
      created.push(frame);
      nodes[frame.id] = frame;
      return frame;
    },
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  const run = async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const msg = posted.find((m) => m.type === "uxd-local-result");
    assert.ok(msg, "no result for " + op + ": " + JSON.stringify(posted));
    if (msg.error) throw new Error(msg.error);
    return msg.result;
  };
  return { figma, run, created };
}

test("insert-icons adds before the label in auto layout, coloured like the label; swap hides the old icon; instances are skipped", async () => {
  const blue = { r: 0.1, g: 0.3, b: 0.9 };
  const label = { id: "t1", type: "TEXT", characters: "Pay now", fontSize: 16, fills: [{ type: "SOLID", color: blue }], x: 16, y: 12, width: 60, height: 20 };
  const button: any = { id: "b1", type: "FRAME", name: "Primary CTA", layoutMode: "HORIZONTAL", counterAxisAlignItems: "MIN", itemSpacing: 0, width: 160, height: 48, children: [label] };
  const oldIcon = { id: "i1", type: "VECTOR", name: "Vector", width: 24, height: 24, x: 8, y: 8, visible: true, strokes: [{ type: "SOLID", color: blue }], fills: [] };
  const row: any = { id: "r1", type: "FRAME", name: "Row", layoutMode: "NONE", width: 320, height: 40, children: [oldIcon] };
  const inst = { id: "n1", type: "INSTANCE", name: "Button instance", width: 120, height: 40, children: [] };
  const nodes: Record<string, any> = { b1: button, t1: label, r1: row, i1: oldIcon, n1: inst };
  const { figma, run } = makeRuntime(nodes);

  figma.currentPage.selection = [button];
  const found = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((t: any) => [t.id, t.label]))), [["b1", "Pay now"]]);

  const result = await run("insert-icons", { items: [
    { targetId: "b1", svg: LUCIDE, name: "credit-card" },
    { targetId: "i1", svg: LUCIDE, name: "bell" },
    { targetId: "n1", svg: LUCIDE, name: "x" },
  ] });
  assert.equal(result.inserted.length, 2);
  assert.equal(button.children[0].name, "Icon / credit-card");
  assert.equal(button.children[0].width, 20, "16px label gets a 20px icon");
  assert.deepEqual(JSON.parse(JSON.stringify(button.children[0].children[0].strokes[0].color)), blue);
  assert.equal(button.counterAxisAlignItems, "CENTER");
  assert.equal(button.itemSpacing, 8, "the icon gets a gap instead of touching its label");
  assert.equal(button.children[0].getPluginData("uxdCreated"), "1");
  assert.equal(oldIcon.visible, false, "swapped icon is hidden, not deleted");
  assert.equal(row.children[1].name, "Icon / bell");
  assert.equal(result.skipped[0].id, "n1");

  await run("delete-created", { nodeIds: result.createdIds });
  const restored = await run("restore-props", { items: result.restore });
  assert.equal(oldIcon.visible, true);
  assert.equal(button.counterAxisAlignItems, "MIN");
  assert.equal(button.itemSpacing, 0);
  assert.equal(restored.restored, 3);
});

test("find-icon-targets on a screen picks buttons only, not label/value data rows", async () => {
  const txt = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 0, y: 0, width: 80, height: 18 });
  const pay: any = { id: "p1", type: "FRAME", name: "Frame 12", width: 140, height: 44, cornerRadius: 22,
    fills: [{ type: "SOLID", color: { r: 0, g: 0.3, b: 1 } }], children: [txt("pt", "Pay now")] };
  const row: any = { id: "row1", type: "FRAME", name: "Row · Loan Amount", width: 320, height: 40, fills: [], children: [txt("rl", "Loan Amount"), txt("rv", "₹2,00,000")] };
  const plain: any = { id: "row2", type: "FRAME", name: "Personal Loan", width: 320, height: 40, fills: [], children: [txt("pl", "Personal Loan")] };
  const screen: any = { id: "s1", type: "FRAME", name: "Screen", width: 360, height: 800, children: [row, plain, pay] };
  const nodes: Record<string, any> = { s1: screen, p1: pay, row1: row, row2: plain };
  const { figma, run } = makeRuntime(nodes);
  figma.currentPage.selection = [screen];
  const found = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((t: any) => t.id))), ["p1"]);

  figma.currentPage.selection = [row];
  const direct = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(direct.targets.map((t: any) => t.id))), ["row1"], "a directly selected row still gets an icon");

  const list: any = { id: "l1", type: "FRAME", name: "List", width: 360, height: 200, children: [plain] };
  nodes.l1 = list;
  figma.currentPage.selection = [list];
  const rows = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(rows.targets.map((t: any) => t.id))), ["row2"], "with no button in the selection, rows are used");
});

test("data rows (label + amount/date value) get no auto icon; action rows still do", async () => {
  const mkText = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 0, y: 0, width: 80, height: 18 });
  const dataRow: any = { id: "d1", type: "FRAME", name: "Row", layoutMode: "HORIZONTAL", width: 320, height: 48, children: [mkText("dt1", "Account balance"), mkText("dt2", "₹12,400.00")] };
  const dateRow: any = { id: "d2", type: "FRAME", name: "Row", layoutMode: "HORIZONTAL", width: 320, height: 48, children: [mkText("dt3", "Due date"), mkText("dt4", "12 Nov 2026")] };
  const actionRow: any = { id: "a1", type: "FRAME", name: "Row", layoutMode: "HORIZONTAL", width: 320, height: 48, children: [mkText("at1", "Download statement")] };
  const list: any = { id: "l1", type: "FRAME", name: "List", layoutMode: "VERTICAL", width: 360, height: 400, children: [dataRow, dateRow, actionRow] };
  const nodes: Record<string, any> = { l1: list, d1: dataRow, d2: dateRow, a1: actionRow };
  const { figma, run } = makeRuntime(nodes);
  figma.currentPage.selection = [list];
  const found = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((t: any) => t.id))), ["a1"]);
});

test("a selected data row is labelled by its label text, not its value, whatever the layer order", async () => {
  const txt = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 0, y: 0, width: 80, height: 18 });
  const row: any = { id: "rd", type: "FRAME", name: "Row · Due", width: 320, height: 40, fills: [], children: [txt("v", "₹1,00,000"), txt("l", "Due")] };
  const { figma, run } = makeRuntime({ rd: row });
  figma.currentPage.selection = [row];
  const found = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((t: any) => [t.id, t.label]))), [["rd", "Due"]]);
});
