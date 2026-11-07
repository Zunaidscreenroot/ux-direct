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

test("a selected row with nested label/value frames and a status badge gets an icon for its label", async () => {
  const txt = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 0, y: 0, width: 80, height: 18 });
  const label: any = { id: "rl", type: "FRAME", name: "Row label · Due", width: 80, height: 18, children: [txt("rlt", "Due")] };
  const value: any = { id: "rv", type: "FRAME", name: "Row value · ₹1,00,000", width: 80, height: 18, children: [txt("rvt", "₹1,00,000")] };
  const rowText: any = { id: "rt", type: "FRAME", name: "Row text · Due", width: 200, height: 40, children: [value, label] };
  const badge: any = { id: "bd", type: "FRAME", name: "Status badge · Pending", width: 70, height: 24, cornerRadius: 12, fills: [{ type: "SOLID", color: { r: 1, g: 0.9, b: 0.6 } }], children: [txt("bdt", "Pending")] };
  const row: any = { id: "row", type: "FRAME", name: "Row · Due", layoutMode: "HORIZONTAL", width: 320, height: 56, children: [rowText, badge] };
  const { figma, run } = makeRuntime({ row, rt: rowText, rl: label, rv: value, bd: badge });
  figma.currentPage.selection = [row];
  const found = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((t: any) => [t.id, t.label]))), [["row", "Due"]]);
});

test("the real Loan Dashboard row: value as a direct child, label nested in Row text, badge beside", async () => {
  const txt = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 0, y: 0, width: 80, height: 18 });
  const rowText: any = { id: "rt2", type: "FRAME", name: "Row text · Due", width: 187, height: 38, children: [txt("l2", "Due"), txt("c2", "12 Mar 2026")] };
  const badge: any = { id: "bd2", type: "FRAME", name: "Status badge · Pending", width: 71, height: 24, children: [txt("b2", "Pending")] };
  const row: any = { id: "row2", type: "FRAME", name: "Row · Due", layoutMode: "HORIZONTAL", width: 328, height: 62, children: [rowText, txt("v2", "₹1,00,000"), badge] };
  const { figma, run } = makeRuntime({ row2: row, rt2: rowText, bd2: badge });
  figma.currentPage.selection = [row];
  const found = await run("find-icon-targets", {});
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((t: any) => [t.id, t.label]))), [["row2", "Due"]]);
});

test("a row whose sibling rows use a Leading icon box gets the same box around its new icon", async () => {
  const txt = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 0, y: 0, width: 80, height: 18 });
  const lead: any = { id: "ld", type: "FRAME", name: "Leading", width: 36, height: 36, cornerRadius: 18, fills: [{ type: "SOLID", color: { r: 0.9, g: 0.95, b: 1 } }], children: [txt("ck", "✓")] };
  lead.clone = function () {
    const copy: any = { ...this, id: "ldc", children: this.children.map((c: any) => ({ ...c, id: c.id + "c" })) };
    copy.children.forEach((c: any) => { c.parent = copy; c.remove = function () { copy.children.splice(copy.children.indexOf(this), 1); }; });
    copy.appendChild = function (c: any) { c.parent = copy; copy.children.push(c); };
    copy.data = {}; copy.setPluginData = function (k: string, v: string) { copy.data[k] = v; }; copy.getPluginData = function (k: string) { return copy.data[k] || ""; };
    return copy;
  };
  const paid: any = { id: "rp", type: "FRAME", name: "Row · Paid", layoutMode: "HORIZONTAL", itemSpacing: 12, width: 328, height: 62, children: [lead, txt("pl", "Paid")] };
  const due: any = { id: "rd3", type: "FRAME", name: "Row · Due", layoutMode: "HORIZONTAL", itemSpacing: 12, width: 328, height: 62, children: [txt("dl", "Due")] };
  const card: any = { id: "cd", type: "FRAME", name: "Repayment Schedule", layoutMode: "VERTICAL", width: 360, height: 200, children: [paid, due] };
  const { run } = makeRuntime({ cd: card, rp: paid, rd3: due, ld: lead });
  const result = await run("insert-icons", { items: [{ targetId: "rd3", svg: '<svg width="24" height="24"></svg>', name: "calendar" }] });
  assert.equal(result.inserted.length, 1);
  assert.equal(due.children[0].name, "Leading / calendar");
  assert.equal(due.children[0].width, 36);
  assert.equal(due.children[0].children.length, 1, "the copied box holds only the new icon");
  assert.equal(due.children[0].children[0].name, "Icon / calendar");
  assert.equal(due.children[0].getPluginData("uxdCreated"), "1", "Revert deletes the whole box");
});

test("rows with label and value in one text use the label part for the icon", async () => {
  const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
  const start = code.indexOf("function uxdLabelPart");
  const end = code.indexOf("function uxdIconTargetInfo");
  const sandbox: Record<string, any> = {};
  runInNewContext(code.slice(start, end) + "\nthis.fn = uxdLabelPart;", sandbox);
  const part = (characters: string) => sandbox.fn({ characters });
  assert.equal(part("EMI  ₹9,450"), "EMI");
  assert.equal(part("Next due  05 Dec"), "Next due");
  assert.equal(part("Status  On track"), "Status");
  assert.equal(part("Balance ₹12,400"), "Balance");
  assert.equal(part("₹9,450"), "");
  assert.equal(part("Pay now"), "");
});

test("'add icons to these rows' includes label+value rows and makes room in absolute rows, with exact Revert", async () => {
  const classify = classifier();
  assert.deepEqual(classify("add icons to these rows", { selectionTypes: ["FRAME"] }), { kind: "icon", mode: "auto", rows: true });
  const t = (id: string, characters: string) => ({ id, type: "TEXT", characters, fontSize: 14, fills: [], x: 16, y: 16, width: 140, height: 20, visible: true });
  const mk = (id: string, characters: string) => ({ id, type: "FRAME", name: "Row " + id, layoutMode: "NONE", width: 312, height: 52, fills: [], children: [t(id + "t", characters)] });
  const r1: any = mk("1", "EMI  ₹9,450"), r2: any = mk("2", "Next due  05 Dec"), r3: any = mk("3", "Status  On track");
  const stack: any = { id: "st", type: "FRAME", name: "Stack", layoutMode: "VERTICAL", width: 312, height: 180, children: [r1, r2, r3] };
  const nodes: Record<string, any> = { st: stack, "1": r1, "2": r2, "3": r3, "1t": r1.children[0], "2t": r2.children[0], "3t": r3.children[0] };
  const { figma, run } = makeRuntime(nodes);
  figma.currentPage.selection = [stack];
  const found = await run("find-icon-targets", { rows: true });
  assert.deepEqual(JSON.parse(JSON.stringify(found.targets.map((x: any) => x.label))), ["EMI", "Next due", "Status"]);
  const result = await run("insert-icons", { items: found.targets.map((x: any) => ({ targetId: x.id, svg: LUCIDE, name: "calendar" })) });
  assert.equal(result.inserted.length, 3, JSON.stringify(result.skipped));
  assert.ok(r1.children[0].x >= 16 + 20, "label shifted right to make room: " + JSON.stringify(r1.children.map((c: any) => [c.name, c.x])));
  await run("delete-created", { nodeIds: result.createdIds });
  await run("restore-props", { items: result.restore });
  assert.equal(r1.children[0].x, 16);
});
