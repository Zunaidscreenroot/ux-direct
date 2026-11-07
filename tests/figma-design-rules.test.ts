/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

function classifier(): (prompt: string, ctx: any) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = classifyQuickTask;", sandbox);
  return (prompt, ctx) => plain(sandbox.fn(prompt, ctx));
}
function parser(): (text: string) => any {
  const match = /\/\/ uxd-design-rules:start([\s\S]*?)\/\/ uxd-design-rules:end/.exec(ui);
  assert.ok(match);
  const sandbox: any = { Set, Number, Math, String, Object, Array };
  runInNewContext(match[1] + "\nthis.parse = parseDesignRules;", sandbox);
  return (text) => plain(sandbox.parse(text));
}

test("design rules prompts are recognised with and without a selection", () => {
  const classify = classifier();
  assert.deepEqual(classify("design rules: spacing 4/8/16", { selectionTypes: [] }), { kind: "design-rules", mode: "set", text: "spacing 4/8/16" });
  assert.deepEqual(classify("show design rules", { selectionTypes: ["FRAME"] }), { kind: "design-rules", mode: "show" });
  assert.deepEqual(classify("clear the design rules", { selectionTypes: [] }), { kind: "design-rules", mode: "clear" });
});

test("design rules text is parsed into scales, colours, font and tone", () => {
  const parse = parser();
  assert.deepEqual(parse("spacing 4/8/12/16/24, radius 8/16, type 12/14/16/20/28, min text 12, primary #2563eb, danger: #D92D20, font: Inter, tone: clear and formal"), {
    spacing: [4, 8, 12, 16, 24], radii: [8, 16], typeScale: [12, 14, 16, 20, 28], minText: 12,
    colors: { primary: "#2563EB", danger: "#D92D20" }, font: "Inter", tone: "clear and formal",
  });
  assert.deepEqual(parse("Use friendly copy only."), {});
});

test("hygiene fix snaps to the file's own spacing scale and radii when rules are set", async () => {
  const data: Record<string, string> = {};
  const page: any = { id: "0:1", type: "PAGE", children: [], selection: [] };
  const mk = (props: any, parent: any) => {
    const n: any = { visible: true, locked: false, x: 0, y: 0, width: 200, height: 100, fills: [], strokes: [], children: [], parent, ...props };
    for (const k of ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing"]) n[k] = n[k] ?? 0;
    n.findAll = (fn: any) => { const out: any[] = []; (function walk(x: any) { (x.children || []).forEach((c: any) => { if (fn(c)) out.push(c); walk(c); }); })(n); return out; };
    parent.children.push(n);
    return n;
  };
  const screen = mk({ id: "1", type: "FRAME", name: "Screen", layoutMode: "VERTICAL", paddingLeft: 15, paddingRight: 15, paddingTop: 10, paddingBottom: 10, itemSpacing: 21 }, page);
  const card = mk({ id: "2", type: "FRAME", name: "Card", layoutMode: "NONE", cornerRadius: 10 }, screen);
  const pill = mk({ id: "3", type: "FRAME", name: "Pill", layoutMode: "NONE", width: 60, height: 20, cornerRadius: 10 }, screen);
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: page,
    root: { children: [page], getPluginData: (k: string) => data[k] || "", setPluginData: (k: string, v: string) => { data[k] = v; } },
    mixed: Symbol("m"), viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => [], loadFontAsync: async () => {}, getNodeByIdAsync: async () => null,
    getLocalPaintStylesAsync: async () => [], getLocalTextStylesAsync: async () => [], variables: { getLocalVariablesAsync: async () => [] },
  };
  page.findOne = () => null;
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  const run = async (op: string, payload: any) => {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op, payload });
    const m = posted.find((x) => x.type === "uxd-local-result");
    if (m.error) throw new Error(m.error);
    return m.result;
  };
  await run("set-design-rules", { text: "spacing 8/16/24, radius 8/16", rules: { spacing: [8, 16, 24], radii: [8, 16] } });
  assert.deepEqual(plain((await run("get-design-rules", {})).rules), { spacing: [8, 16, 24], radii: [8, 16] });
  page.selection = [screen];
  const result = await run("apply-hygiene-fixes", { groups: ["spacing"] });
  assert.equal(result.usedRules, true);
  assert.deepEqual([screen.paddingLeft, screen.paddingTop, screen.itemSpacing], [16, 8, 24], "15→16, 10→8, 21→24 on the file scale (not the 4px grid)");
  assert.equal(card.cornerRadius, 8);
  assert.equal(pill.cornerRadius, 10, "a pill keeps its fully rounded ends");
  assert.equal(result.counts.radius, 1);
});

test("an older server that rejects designRules gets the same request again without them", async () => {
  const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
  const match = /(async function postJsonWithRules[\s\S]*?\n    \}\n)/.exec(ui);
  assert.ok(match);
  const bodies: any[] = [];
  const fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const strict = "designRules" in body;
    const text = strict ? JSON.stringify({ error: "invalid", details: [{ message: "Unrecognized key: 'designRules'" }] }) : "{\"ok\":true}";
    return { status: strict ? 400 : 200, clone() { return { text: async () => text }; }, json: async () => JSON.parse(text) };
  };
  const sandbox: Record<string, any> = { fetch, console: { warn() {} } };
  runInNewContext(match[1] + "\nthis.fn = postJsonWithRules;", sandbox);
  const ok = await sandbox.fn("https://x/api", { prompt: "p", designRules: "spacing 8/16" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies)), [{ prompt: "p", designRules: "spacing 8/16" }, { prompt: "p" }]);
  bodies.length = 0;
  await sandbox.fn("https://x/api", { prompt: "p" });
  assert.equal(bodies.length, 1, "no rules, no retry");
});
