/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory Figma mock is intentionally untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { formatHygieneReport, runHygieneCheck } from "../src/figma-agent/hygiene-check";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function classifier(): (prompt: string, ctx: any) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = classifyQuickTask;", sandbox);
  return (prompt: string, ctx: any) => { const out = sandbox.fn(prompt, ctx); return out === null ? null : JSON.parse(JSON.stringify(out)); };
}

test("fix prompts route to the deterministic hygiene fixer with the right groups", () => {
  const classify = classifier();
  const frame = { selectionTypes: ["FRAME"] };
  assert.deepEqual(classify("fix hygiene", frame), { kind: "hygiene-fix", groups: ["spacing", "tokens"] });
  assert.deepEqual(classify("fix the hygiene issues", frame).groups, ["spacing", "tokens"]);
  assert.deepEqual(classify("fix spacing", frame).groups, ["spacing"]);
  assert.deepEqual(classify("tokenize the colours", frame).groups, ["tokens"]);
  assert.deepEqual(classify("bind colours to variables", frame).groups, ["tokens"]);
  assert.deepEqual(classify("fix contrast", frame).groups, ["a11y"]);
  assert.deepEqual(classify("fix accessibility issues", frame).groups, ["a11y"]);
  assert.deepEqual(classify("fix auto layout", frame).groups, ["layout"]);
  assert.deepEqual(classify("fix all hygiene issues", frame).groups, ["spacing", "tokens", "a11y", "layout"]);
  assert.deepEqual(classify("saare issues theek kar do", frame).groups, ["spacing", "tokens", "a11y", "layout"]);
  // Reports stay reports, and other fixes keep their paths.
  assert.equal(classify("run a hygiene check", frame).kind, "hygiene");
  assert.equal(classify("fix grammar", { selectionTypes: ["TEXT"] }).kind, "rewrite-text");
  assert.notEqual(classify("fix hygiene", { selectionTypes: [] })?.kind, "hygiene-fix", "no selection, no fix");
  assert.equal(classify("revert the hygiene fix", frame).kind, "revert");
});

test("the hygiene report offers the one-click fixes it can do", () => {
  const report = runHygieneCheck({ nodes: [{ id: "1", type: "FRAME", name: "Card", layoutMode: "VERTICAL", paddingLeft: 15, paddingRight: 17, paddingTop: 16, paddingBottom: 16, itemSpacing: 8, children: [] }] });
  const text = formatHygieneReport(report);
  assert.match(text, /fix hygiene/);
});

function runtime() {
  let next = 1;
  const page: any = { id: "0:1", type: "PAGE", name: "Page 1", children: [], selection: [] };
  const all: any[] = [];
  const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
  const solid = (hex: string) => [{ type: "SOLID", color: rgb(hex), opacity: 1, visible: true }];
  function make(props: any, parent: any = page) {
    const n: any = { id: "1:" + next++, visible: true, locked: false, x: 0, y: 0, width: 100, height: 40, fills: [], strokes: [], ...props };
    if (n.type === "FRAME" || n.type === "INSTANCE") {
      n.children = n.children || [];
      n.layoutMode = n.layoutMode || "NONE";
      for (const k of ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing"]) n[k] = n[k] ?? 0;
      n.primaryAxisAlignItems = n.primaryAxisAlignItems || "MIN";
      n.minHeight = null; n.minWidth = null;
      n.insertChild = (i: number, c: any) => { n.children.splice(n.children.indexOf(c), 1); n.children.splice(i, 0, c); };
    }
    if (n.type === "TEXT") {
      n.fontName = n.fontName || { family: "Inter", style: "Regular" };
      n.fontSize = n.fontSize || 14;
      n.lineHeight = { unit: "AUTO" }; n.letterSpacing = { unit: "PERCENT", value: 0 };
      n.getRangeAllFontNames = () => [n.fontName];
      n.textStyleId = "";
      n.setTextStyleIdAsync = async (id: string) => { n.textStyleId = id; };
    }
    n.fillStyleId = "";
    n.setFillStyleIdAsync = async (id: string) => { n.fillStyleId = id; };
    n.parent = parent; parent.children.push(n); all.push(n);
    return n;
  }
  const screen = make({ type: "FRAME", name: "Screen", width: 375, height: 800, fills: solid("#FFFFFF"), layoutMode: "VERTICAL", paddingLeft: 15, paddingRight: 19, paddingTop: 23, paddingBottom: 24, itemSpacing: 10 });
  const title = make({ type: "TEXT", name: "Title", characters: "Loan summary", fontSize: 20, fontName: { family: "Inter", style: "Bold" }, fills: solid("#111827") }, screen);
  const faint = make({ type: "TEXT", name: "Hint", characters: "Due 5 Dec", fontSize: 10, fills: solid("#D1D5DB") }, screen);
  const button = make({ type: "FRAME", name: "Button", width: 120, height: 36, layoutMode: "HORIZONTAL", paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8, fills: solid("#2563EB") }, screen);
  const instance = make({ type: "INSTANCE", name: "Chip", width: 60, height: 24, layoutMode: "HORIZONTAL", paddingLeft: 5, fills: solid("#2563EB") }, screen);
  const instanceLabel = make({ type: "TEXT", name: "Chip label", characters: "New", fontSize: 9, fills: solid("#FFFFFF") }, instance);
  const stack = make({ type: "FRAME", name: "Rows", width: 343, height: 100 }, screen);
  const rowA = make({ type: "FRAME", name: "Row A", y: 0, height: 40 }, stack);
  make({ type: "FRAME", name: "Row B", y: 52, height: 40 }, stack);
  const colorVar = { id: "VariableID:1", name: "color/primary", resolvedType: "COLOR", variableCollectionId: "C1", scopes: ["ALL_SCOPES"], valuesByMode: { m1: { ...rgb("#2563EB"), a: 1 } } };
  const textVar = { id: "VariableID:2", name: "text/primary", resolvedType: "COLOR", variableCollectionId: "C1", scopes: ["ALL_SCOPES"], valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "VariableID:3" } } };
  const baseVar = { id: "VariableID:3", name: "gray/900", resolvedType: "COLOR", variableCollectionId: "C1", scopes: [], valuesByMode: { m1: { ...rgb("#111827"), a: 1 } } };
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: page, root: { children: [page] }, mixed: Symbol("mixed"),
    viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (m: any) => posted.push(m), onmessage: null },
    showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {},
    getNodeByIdAsync: async (id: string) => all.find((x) => x.id === id) || null,
    getLocalPaintStylesAsync: async () => [{ id: "S:white", name: "Surface/White", paints: solid("#FFFFFF") }],
    getLocalTextStylesAsync: async () => [{ id: "T:h2", name: "Heading/H2", fontName: { family: "Inter", style: "Bold" }, fontSize: 20, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 } }],
    variables: {
      getLocalVariablesAsync: async () => [colorVar, textVar, baseVar],
      getVariableCollectionByIdAsync: async () => ({ id: "C1", defaultModeId: "m1" }),
      getVariableByIdAsync: async (id: string) => [colorVar, textVar, baseVar].find((v) => v.id === id) || null,
      setBoundVariableForPaint: (paint: any, _field: string, variable: any) => ({ ...paint, boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } } }),
    },
  };
  page.findOne = (fn: any) => all.find(fn) || null;
  const sandbox: any = { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout };
  runInNewContext(code, sandbox);
  async function fix(groups: string[]) {
    page.selection = [screen];
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op: "apply-hygiene-fixes", payload: { groups } });
    const message = posted.find((m) => m.type === "uxd-local-result");
    if (message.error) throw new Error(message.error);
    return message.result;
  }
  return { fix, make, screen, title, faint, button, instance, instanceLabel, stack, rowA, rgb, figma, posted };
}

test("spacing fix snaps to the 4px grid and evens near-symmetric padding", async () => {
  const r = runtime();
  const result = await r.fix(["spacing"]);
  assert.equal(r.screen.paddingTop, 24);
  assert.equal(r.screen.itemSpacing, 12);
  assert.equal(r.screen.paddingLeft, 20, "16/20 → both 20");
  assert.equal(r.screen.paddingRight, 20);
  assert.equal(r.instance.paddingLeft, 5, "instances are never touched");
  assert.ok(result.counts.spacing >= 1 && result.counts.symmetry === 1);
});

test("token fix binds exact colour matches (through aliases) and text styles, without changing the look", async () => {
  const r = runtime();
  const before = JSON.stringify(r.button.fills[0].color);
  const result = await r.fix(["tokens"]);
  assert.equal(r.button.fills[0].boundVariables.color.id, "VariableID:1");
  assert.equal(JSON.stringify(r.button.fills[0].color), before, "colour value unchanged");
  assert.equal(r.title.fills[0].boundVariables.color.id, "VariableID:2", "text prefers the text/ variable, resolved through its alias");
  assert.equal(r.screen.fillStyleId, "S:white", "paint style used when no variable matches");
  assert.equal(r.title.textStyleId, "T:h2");
  assert.equal(r.faint.textStyleId, "", "no exact text style for the hint");
  assert.equal(r.instance.fills[0].boundVariables, undefined);
  assert.equal(result.counts.textStyles, 1);
});

test("accessibility fix lifts contrast and small text and gives buttons 44px", async () => {
  const r = runtime();
  await r.fix(["a11y"]);
  assert.equal(r.faint.fontSize, 12);
  const c = r.faint.fills[0].color;
  const lum = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lum(c.r) + 0.7152 * lum(c.g) + 0.0722 * lum(c.b);
  assert.ok((1.05) / (L + 0.05) >= 4.5, "hint text reaches 4.5:1 on white");
  assert.equal(r.button.minHeight, 44);
});

test("layout fix adds auto layout to cleanly stacked frames only", async () => {
  const r = runtime();
  const result = await r.fix(["layout"]);
  assert.equal(r.stack.layoutMode, "VERTICAL");
  assert.equal(r.stack.itemSpacing, 12);
  assert.equal(result.counts.autoLayout, 1);
});

test("accessibility fix reaches text inside instances as overrides, but structure inside instances is untouched", async () => {
  const r = runtime();
  const inner = (r as any).instanceLabel;
  await r.fix(["a11y", "spacing"]);
  assert.equal(inner.fontSize, 12, "small label inside an instance raised to 12px");
  assert.equal(r.instance.paddingLeft, 5, "instance padding is not changed");
});

test("hygiene revert restores the snapshot, keeping later manual edits", async () => {
  const r = runtime();
  const result = await r.fix(["spacing", "tokens", "a11y"]);
  assert.ok(result.snapshot.length > 0);
  assert.equal(result.layoutChanged, false);
  const sandboxFigma = (r as any).figma;
  r.button.paddingTop = 30; // designer edits after the fix
  const posted: any[] = (r as any).posted;
  posted.length = 0;
  await sandboxFigma.ui.onmessage({ type: "uxd-local-task", requestId: "r2", op: "restore-props", payload: { items: result.snapshot } });
  const restore = posted.find((m: any) => m.type === "uxd-local-result").result;
  assert.ok(restore.restored > 0);
  assert.equal(r.screen.paddingTop, 23, "grid snap undone");
  assert.equal(r.screen.paddingLeft, 15);
  assert.equal(r.faint.fontSize, 10, "small text restored");
  assert.equal(r.title.textStyleId, "", "text style detached again");
  assert.equal(r.button.fills[0].boundVariables, undefined, "variable binding removed");
});

test("spacing fix aligns repeated items that drifted apart to the group's most common values", async () => {
  const r = runtime();
  const list = r.make({ type: "FRAME", name: "List", width: 343, height: 300, layoutMode: "VERTICAL" }, r.screen);
  const card = (pad: number, gap: number, radius: number) => r.make({ type: "FRAME", name: "Card", layoutMode: "HORIZONTAL",
    paddingLeft: pad, paddingRight: pad, paddingTop: 12, paddingBottom: 12, itemSpacing: gap, cornerRadius: radius }, list);
  const a = card(16, 8, 8), b = card(16, 8, 8), c = card(12, 12, 12);
  const result = await r.fix(["spacing"]);
  assert.deepEqual([c.paddingLeft, c.paddingRight, c.itemSpacing, c.cornerRadius], [16, 16, 8, 8]);
  assert.deepEqual([a.paddingLeft, b.itemSpacing], [16, 8], "the majority is unchanged");
  assert.equal(result.counts.repeated, 1);
  assert.ok(result.snapshot.some((item: any) => item.id === c.id && item.prop === "cornerRadius" && item.before === 12));
});
