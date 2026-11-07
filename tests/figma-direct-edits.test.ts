/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory Figma mock is intentionally untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function extract(start: string, end: string, name: string): any {
  const match = new RegExp("// " + start + "([\\s\\S]*?)// " + end).exec(ui);
  assert.ok(match, start + " markers exist in ui.html");
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.fn = " + name + ";", sandbox);
  return sandbox.fn;
}
const parse: (prompt: string, ctx: any) => any = extract("uxd-direct-edit-parser:start", "uxd-direct-edit-parser:end", "parseDirectEdit");
const classify: (prompt: string, ctx: any) => any = extract("uxd-quick-task-classifier:start", "uxd-quick-task-classifier:end", "classifyQuickTask");

const TEXT = { selectionTypes: ["TEXT"] };
const FRAME = { selectionTypes: ["FRAME"] };
const TWO = { selectionTypes: ["FRAME", "RECTANGLE"] };

// Every everyday edit a designer asks the Figma agent for, in English and Hinglish, with the op it must become.
// [selection, prompt, expected ops as {target, noun?, set | action}]
const CASES: Array<[any, string, any[]]> = [
  // Text colour
  [TEXT, "make text white", [{ target: "text", set: { fill: "#FFFFFF" } }]],
  [TEXT, "make it red", [{ target: "text", set: { fill: "#EF4444" } }]],
  [TEXT, "change the text colour to #1a73e8", [{ target: "text", set: { fill: "#1A73E8" } }]],
  [FRAME, "make the text white", [{ target: "text", set: { fill: "#FFFFFF" } }]],
  [TEXT, "text ka color white kar do", [{ target: "text", set: { fill: "#FFFFFF" } }]],
  [TEXT, "isko safed kar do", [{ target: "text", set: { fill: "#FFFFFF" } }]],
  [FRAME, "make the button text white", [{ target: "text", noun: "button", set: { fill: "#FFFFFF" } }]],
  [FRAME, "white text", [{ target: "text", set: { fill: "#FFFFFF" } }]],
  // Fill / background
  [FRAME, "make the background #F5F5F5", [{ target: "bg", set: { fill: "#F5F5F5" } }]],
  [FRAME, "change background colour to light grey", [{ target: "bg", set: { fill: "#C4C7CC" } }]],
  [FRAME, "background ka rang neela karo", [{ target: "bg", set: { fill: "#2563EB" } }]],
  [FRAME, "make it blue", [{ target: "self", set: { fill: "#2563EB" } }]],
  [FRAME, "fill red", [{ target: "bg", set: { fill: "#EF4444" } }]],
  [FRAME, "make the button blue", [{ target: "self", noun: "button", set: { fill: "#2563EB" } }]],
  [FRAME, "button ko neela kar do", [{ target: "self", noun: "button", set: { fill: "#2563EB" } }]],
  [FRAME, "make all icons grey", [{ target: "self", noun: "icon", set: { fill: "#6B7280" } }]],
  [FRAME, "make the card dark blue", [{ target: "self", noun: "card", set: { fill: "#184099" } }]],
  [FRAME, "transparent background", [{ target: "bg", set: { fillNone: true } }]],
  [FRAME, "remove background colour", [{ target: "bg", set: { fillNone: true } }]],
  [FRAME, "blue to purple gradient", [{ target: "bg", set: { gradient: ["#2563EB", "#8B5CF6"] } }]],
  [FRAME, "make it darker", [{ target: "self", set: { colorShift: -0.2 } }]],
  [TEXT, "make text a bit lighter", [{ target: "text", set: { colorShift: 0.25 } }]],
  // Border
  [FRAME, "add a 1px grey border", [{ target: "self", set: { stroke: { color: "#6B7280", weight: 1 } } }]],
  [FRAME, "border 2px red", [{ target: "self", set: { stroke: { color: "#EF4444", weight: 2 } } }]],
  [FRAME, "dashed border", [{ target: "self", set: { stroke: { dash: "dashed" } } }]],
  [FRAME, "remove border", [{ target: "self", set: { strokeNone: true } }]],
  [FRAME, "border hatao", [{ target: "self", set: { strokeNone: true } }]],
  // Corners
  [FRAME, "border radius 8", [{ target: "self", set: { radius: 8 } }]],
  [FRAME, "corner radius 16px", [{ target: "self", set: { radius: 16 } }]],
  [FRAME, "round the corners 12", [{ target: "self", set: { radius: 12 } }]],
  [FRAME, "make the corners rounded", [{ target: "self", set: { radius: 12 } }]],
  [FRAME, "make it pill shaped", [{ target: "self", set: { radiusPill: true } }]],
  [FRAME, "sharp corners", [{ target: "self", set: { radius: 0 } }]],
  [FRAME, "more rounded", [{ target: "self", set: { radiusDelta: 4 } }]],
  // Opacity and effects
  [FRAME, "opacity 50%", [{ target: "self", set: { opacity: 0.5 } }]],
  [FRAME, "make it semi transparent", [{ target: "self", set: { opacity: 0.5 } }]],
  [FRAME, "add shadow", [{ target: "self", set: { shadow: "soft" } }]],
  [FRAME, "add a strong drop shadow", [{ target: "self", set: { shadow: "strong" } }]],
  [FRAME, "shadow lagao", [{ target: "self", set: { shadow: "soft" } }]],
  [FRAME, "inner shadow", [{ target: "self", set: { shadow: "inner" } }]],
  [FRAME, "remove shadow", [{ target: "self", set: { shadowNone: true } }]],
  [FRAME, "background blur 20", [{ target: "self", set: { blur: { type: "BACKGROUND_BLUR", radius: 20 } } }]],
  [FRAME, "remove effects", [{ target: "self", set: { effectsNone: true } }]],
  // Auto layout, padding, spacing, alignment
  [FRAME, "add auto layout", [{ target: "self", set: { layout: "AUTO" } }]],
  [FRAME, "auto layout lagao", [{ target: "self", set: { layout: "AUTO" } }]],
  [FRAME, "add vertical auto layout", [{ target: "self", set: { layout: "VERTICAL" } }]],
  [FRAME, "make it horizontal", [{ target: "self", set: { layout: "HORIZONTAL" } }]],
  [FRAME, "remove auto layout", [{ target: "self", set: { layoutNone: true } }]],
  [FRAME, "padding 24", [{ target: "self", set: { padding: { top: 24, right: 24, bottom: 24, left: 24 } } }]],
  [FRAME, "padding 16 24", [{ target: "self", set: { padding: { top: 16, bottom: 16, left: 24, right: 24 } } }]],
  [FRAME, "horizontal padding 20", [{ target: "self", set: { padding: { left: 20, right: 20 } } }]],
  [FRAME, "padding ko 24 kar do", [{ target: "self", set: { padding: { top: 24, right: 24, bottom: 24, left: 24 } } }]],
  [FRAME, "more padding", [{ target: "self", set: { paddingDelta: 8 } }]],
  [FRAME, "padding badha do", [{ target: "self", set: { paddingDelta: 8 } }]],
  [FRAME, "remove padding", [{ target: "self", set: { padding: { top: 0, right: 0, bottom: 0, left: 0 } } }]],
  [FRAME, "gap 12", [{ target: "self", set: { gap: 12 } }]],
  [FRAME, "spacing between items 8", [{ target: "self", set: { gap: 8 } }]],
  [FRAME, "less spacing", [{ target: "self", set: { gapDelta: -4 } }]],
  [FRAME, "space between", [{ target: "self", set: { align: { value: "space-between" } } }]],
  [FRAME, "center the items", [{ target: "self", set: { align: { value: "center", axis: null } } }]],
  [FRAME, "center it horizontally", [{ target: "self", set: { align: { value: "center", axis: "h" } } }]],
  [FRAME, "align left", [{ target: "self", set: { align: { value: "left", axis: null } } }]],
  [FRAME, "wrap in auto layout", [{ target: "self", action: "wrap" }]],
  // Size and position
  [FRAME, "width 320", [{ target: "self", set: { width: 320 } }]],
  [FRAME, "make it 48 tall", [{ target: "self", set: { height: 48 } }]],
  [FRAME, "resize to 100x100", [{ target: "self", set: { width: 100 } }, { target: "self", set: { height: 100 } }]],
  [FRAME, "make it full width", [{ target: "self", set: { sizingH: "FILL" } }]],
  [FRAME, "hug contents", [{ target: "self", set: { sizingH: "HUG" } }, { target: "self", set: { sizingV: "HUG" } }]],
  [FRAME, "move it 20px right", [{ target: "self", set: { move: { dx: 20, dy: 0 } } }]],
  [FRAME, "rotate 90", [{ target: "self", set: { rotate: 90 } }]],
  [FRAME, "flip horizontally", [{ target: "self", set: { flip: "h" } }]],
  [FRAME, "clip content", [{ target: "self", set: { clip: true } }]],
  // Typography
  [TEXT, "make this bold and bigger", [{ target: "text", set: { fontWeight: "bold" } }, { target: "text", set: { fontSizeDelta: 2 } }]],
  [TEXT, "bold kar do", [{ target: "text", set: { fontWeight: "bold" } }]],
  [TEXT, "make it semibold", [{ target: "text", set: { fontWeight: "semibold" } }]],
  [TEXT, "remove bold", [{ target: "text", set: { fontWeight: "regular" } }]],
  [TEXT, "font size 18", [{ target: "text", set: { fontSize: 18 } }]],
  [FRAME, "font size 18", [{ target: "text", set: { fontSize: 18 } }]],
  [FRAME, "make the title 24px and bold", [{ target: "text", noun: "title", set: { fontSize: 24 } }, { target: "text", noun: "title", set: { fontWeight: "bold" } }]],
  [TEXT, "text chhota karo", [{ target: "text", set: { fontSizeDelta: -2 } }]],
  [TEXT, "make it italic", [{ target: "text", set: { italic: true } }]],
  [TEXT, "underline this", [{ target: "text", set: { decoration: "UNDERLINE" } }]],
  [TEXT, "strikethrough", [{ target: "text", set: { decoration: "STRIKETHROUGH" } }]],
  [TEXT, "uppercase", [{ target: "text", set: { textCase: "UPPER" } }]],
  [TEXT, "sentence case", [{ target: "text", set: { textCase: "SENTENCE" } }]],
  [TEXT, "center align", [{ target: "text", set: { align: { value: "center", axis: null } } }]],
  [TEXT, "line height 24", [{ target: "text", set: { lineHeight: { unit: "PIXELS", value: 24 } } }]],
  [TEXT, "line height 150%", [{ target: "text", set: { lineHeight: { unit: "PERCENT", value: 150 } } }]],
  [TEXT, "letter spacing 2%", [{ target: "text", set: { letterSpacing: { unit: "PERCENT", value: 2 } } }]],
  [TEXT, "change font to Roboto", [{ target: "text", set: { fontFamily: "Roboto" } }]],
  [TEXT, "font poppins kar do", [{ target: "text", set: { fontFamily: "poppins" } }]],
  [TEXT, "truncate", [{ target: "text", set: { truncate: true } }]],
  // Content and names
  [FRAME, "change text to \"Pay now\"", [{ target: "text", set: { text: "Pay now" } }]],
  [TEXT, "change text to Pay now", [{ target: "text", set: { text: "Pay now" } }]],
  [FRAME, "Change the title to \"My Loans\"", [{ target: "text", noun: "title", set: { text: "My Loans" } }]],
  [FRAME, "change the button text to \"Pay EMI\"", [{ target: "text", noun: "button", set: { text: "Pay EMI" } }]],
  [TEXT, "replace \"₹10,000\" with \"₹5,000\"", [{ target: "text", set: { replace: { from: "₹10,000", to: "₹5,000" } } }]],
  [FRAME, "rename this to Header", [{ target: "self", set: { name: "Header" } }]],
  // Layer actions
  [FRAME, "hide this", [{ target: "self", set: { visible: false } }]],
  [FRAME, "isko chhupa do", [{ target: "self", set: { visible: false } }]],
  [FRAME, "lock it", [{ target: "self", set: { locked: true } }]],
  [FRAME, "duplicate this", [{ target: "self", action: "duplicate", count: 1 }]],
  [FRAME, "duplicate 3 times", [{ target: "self", action: "duplicate", count: 3 }]],
  [FRAME, "ek aur copy bana do", [{ target: "self", action: "duplicate", count: 1 }]],
  [FRAME, "delete this", [{ target: "self", action: "delete" }]],
  [FRAME, "isko delete kar do", [{ target: "self", action: "delete" }]],
  [TWO, "group these", [{ target: "self", action: "group" }]],
  [FRAME, "ungroup", [{ target: "self", action: "ungroup" }]],
  [FRAME, "make this a component", [{ target: "self", action: "component" }]],
  [FRAME, "detach instance", [{ target: "self", action: "detach" }]],
  [FRAME, "bring to front", [{ target: "self", action: "front" }]],
  [FRAME, "delete hidden layers", [{ target: "self", action: "deleteHidden" }]],
  [TWO, "wrap these rows in auto layout", [{ target: "self", action: "wrap" }]],
  [TWO, "wrap the selected cards in a vertical auto layout frame", [{ target: "self", action: "wrap" }]],
  [FRAME, "make this button disabled", [{ target: "self", noun: "button", action: "variant" }]],
  [FRAME, "set the tab to active", [{ target: "self", noun: "tab", action: "variant" }]],
  [FRAME, "add a primary button", [{ target: "self", action: "insertComponent" }]],
  [FRAME, "insert a small outline icon", [{ target: "self", action: "insertComponent" }]],
  [FRAME, "show hidden layers", [{ target: "self", set: { showHidden: true } }]],
  // Several edits in one prompt
  [FRAME, "make the text white and the background black", [{ target: "text", set: { fill: "#FFFFFF" } }, { target: "bg", set: { fill: "#000000" } }]],
  [FRAME, "padding 16, radius 8, white background, shadow", [
    { target: "self", set: { padding: { top: 16, right: 16, bottom: 16, left: 16 } } }, { target: "self", set: { radius: 8 } },
    { target: "bg", set: { fill: "#FFFFFF" } }, { target: "self", set: { shadow: "soft" } }]],
];

function shape(ops: any[]): any[] {
  return ops.map((op) => {
    const out: any = { target: op.target };
    if (op.noun) out.noun = op.noun;
    if (op.action) { out.action = op.action; if (op.count !== undefined) out.count = op.count; } else out.set = op.set;
    return out;
  });
}

test("every common Figma edit prompt becomes a deterministic edit", () => {
  const failures: string[] = [];
  for (const [ctx, prompt, expected] of CASES) {
    const result = parse(prompt, ctx);
    const got = result ? shape(result.ops) : null;
    const want = shape(expected.map((e) => ({ ...e })));
    try { assert.deepEqual(JSON.parse(JSON.stringify(got)), want); }
    catch { failures.push(prompt + " → " + JSON.stringify(got)); }
  }
  assert.deepEqual(failures, [], failures.length + " of " + CASES.length + " prompts were not understood");
});

test("design, generation and unclear prompts are left to the model", () => {
  for (const prompt of ["improve this screen", "make a dark mode version", "make 3 variations", "add a new onboarding screen", "add a soft shadow to the card and a new screen",
    "make it look like the card above", "create a variation with a stronger CTA", "make the card bigger", "insert image of a cat",
    "do a UX audit", "run a hygiene check", "translate this to Hindi", "make this copy shorter", "revert this change", "undo",
    "rename layers", "what is wrong here", "make it pop", "use the primary colour", "apply the Primary/500 style", "export as SVG"]) {
    assert.equal(parse(prompt, FRAME), null, prompt);
  }
  assert.equal(parse("make text white", { selectionTypes: [] }), null, "nothing selected");
});

test("direct edits win over the copy-rewrite and image classifiers, but not background removal or revert", () => {
  // The submit path prefers a direct edit when the classifier picked rewrite-text or generate-image.
  assert.match(ui, /directEdit && \(!quickTask \|\| quickTask\.kind === "rewrite-text" \|\| quickTask\.kind === "generate-image"\)/);
  assert.equal(classify("change text to Pay now", TEXT).kind, "rewrite-text");
  assert.ok(parse("change text to Pay now", TEXT));
  assert.equal(classify("make the image rounded", FRAME).kind, "generate-image");
  assert.ok(parse("make the image rounded", FRAME));
  assert.equal(classify("remove background", { selectionTypes: ["RECTANGLE"] }).kind, "remove-background");
  assert.equal(classify("remove background colour", FRAME), null, "a fill change is not AI background removal");
  assert.equal(classify("revert this change", FRAME).kind, "revert");
  assert.equal(parse("revert this change", FRAME), null);
});

// ---- code.js executor ------------------------------------------------------------------------

const plain = (value: any) => JSON.parse(JSON.stringify(value));

function runtime() {
  let next = 1;
  const page: any = { id: "0:1", type: "PAGE", name: "Page 1", children: [], selection: [] };
  const all: any[] = [];
  const loaded: string[] = [];
  const fonts = [["Inter", "Regular"], ["Inter", "Bold"], ["Inter", "Semi Bold"], ["Inter", "Italic"], ["Roboto", "Regular"], ["Roboto", "Bold"]];
  function attach(parent: any, child: any) { child.parent = parent; parent.children.push(child); }
  function make(props: any, parent: any = page) {
    const n: any = { id: "1:" + next++, visible: true, x: 0, y: 0, width: 100, height: 40, rotation: 0, opacity: 1, fills: [], strokes: [], effects: [],
      locked: false, ...props };
    if (["FRAME", "INSTANCE", "COMPONENT", "GROUP"].includes(n.type)) {
      n.children = []; if (n.type !== "GROUP") { n.layoutMode = n.layoutMode || "NONE"; n.cornerRadius = 0; n.clipsContent = true; n.itemSpacing = 0; n.paddingLeft = 0; n.paddingRight = 0; n.paddingTop = 0; n.paddingBottom = 0; n.primaryAxisAlignItems = "MIN"; n.counterAxisAlignItems = "MIN"; }
      n.insertChild = (i: number, c: any) => { n.children.splice(n.children.indexOf(c), 1); n.children.splice(i, 0, c); };
      n.appendChild = (c: any) => { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); attach(n, c); };
      n.findAll = (fn: any) => { const out: any[] = []; const walk = (x: any) => (x.children || []).forEach((c: any) => { if (fn(c)) out.push(c); walk(c); }); walk(n); return out; };
    }
    if (n.type === "RECTANGLE") n.cornerRadius = 0;
    if (n.type === "TEXT") {
      n.fontName = n.fontName || { family: "Inter", style: "Regular" }; n.fontSize = n.fontSize || 14; n.textAlignHorizontal = "LEFT"; n.textCase = "ORIGINAL";
      n.getRangeAllFontNames = () => [n.fontName];
      n.getStyledTextSegments = () => [{ start: 0, end: n.characters.length, fontName: n.fontName, fontSize: n.fontSize }];
      n.setRangeFontName = (_s: number, _e: number, f: any) => { n.fontName = f; };
      n.setRangeFontSize = (_s: number, _e: number, v: number) => { n.fontSize = v; };
    }
    n.resize = (w: number, h: number) => { n.width = w; n.height = h; };
    n.remove = () => { n.parent.children.splice(n.parent.children.indexOf(n), 1); n.removed = true; };
    n.clone = () => { const c = make({ type: n.type, name: n.name, x: n.x, y: n.y }, n.parent); return c; };
    attach(parent, n); all.push(n);
    return n;
  }
  const screen = make({ type: "FRAME", name: "Checkout", width: 375, height: 800 });
  const card = make({ type: "FRAME", name: "Card", width: 343, height: 200 }, screen);
  const title = make({ type: "TEXT", name: "Title", characters: "Loan summary", fontSize: 20 }, card);
  const body = make({ type: "TEXT", name: "Body", characters: "Pay ₹10,000 by 5 Dec", fontSize: 14, y: 40 }, card);
  const button = make({ type: "INSTANCE", name: "Button / Primary", width: 300, height: 48, y: 100, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }, card);
  const label = make({ type: "TEXT", name: "Button label", characters: "Pay ₹10,000" }, button);
  const hidden = make({ type: "RECTANGLE", name: "Old", visible: false, y: 160 }, card);
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: page, root: { children: [page] }, mixed: Symbol("mixed"),
    viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (m: any) => posted.push(m), onmessage: null },
    showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    listAvailableFontsAsync: async () => fonts.map(([family, style]) => ({ fontName: { family, style } })),
    loadFontAsync: async (f: any) => {
      if (!fonts.some(([family, style]) => family === f.family && style === f.style)) throw new Error("font missing");
      loaded.push(f.family + " " + f.style);
    },
    getNodeByIdAsync: async (id: string) => all.find((x) => x.id === id) || null,
    getLocalPaintStylesAsync: async () => [], getLocalTextStylesAsync: async () => [], variables: { getLocalVariablesAsync: async () => [] },
  };
  page.findOne = (fn: any) => all.find((x) => !x.removed && fn(x)) || null;
  const sandbox: any = { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout };
  runInNewContext(code, sandbox);
  async function apply(prompt: string, selection: any[]) {
    page.selection = selection;
    const parsed = parse(prompt, { selectionTypes: selection.map((n) => n.type) });
    assert.ok(parsed, "parsed: " + prompt);
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r", op: "apply-direct-edits", payload: { ops: parsed.ops } });
    const message = posted.find((m) => m.type === "uxd-local-result");
    if (message.error) throw new Error(message.error);
    return message.result;
  }
  return { apply, make, screen, card, title, body, button, label, hidden, page, figma, sandbox };
}

test("direct edits change real node properties in code.js", async () => {
  const r = runtime();
  await r.apply("make text white", [r.label]);
  assert.deepEqual(plain(r.label.fills[0].color), { r: 1, g: 1, b: 1 });
  await r.apply("make the button blue", [r.screen]);
  assert.equal(Math.round(r.button.fills[0].color.b * 255), 0xEB, "the instance named Button got the fill");
  await r.apply("make the button text white", [r.card]);
  assert.deepEqual(plain(r.label.fills[0].color), { r: 1, g: 1, b: 1 });
  await r.apply("make the title bold", [r.card]);
  assert.deepEqual(plain(r.title.fontName), { family: "Inter", style: "Bold" });
  await r.apply("semibold", [r.body]);
  assert.deepEqual(plain(r.body.fontName), { family: "Inter", style: "Semi Bold" }, "style names are resolved per family");
  await r.apply("make it italic", [r.label]);
  assert.deepEqual(plain(r.label.fontName), { family: "Inter", style: "Italic" });
  await r.apply("text bigger", [r.body]);
  assert.equal(r.body.fontSize, 16);
  await r.apply("change font to roboto", [r.title]);
  assert.deepEqual(plain(r.title.fontName), { family: "Roboto", style: "Bold" }, "the weight survives a family change");
  await assert.rejects(r.apply("change font to Comic Neue", [r.title]), /not available/);
  await r.apply("replace \"₹10,000\" with \"₹5,000\"", [r.body]);
  assert.equal(r.body.characters, "Pay ₹5,000 by 5 Dec");
  await r.apply("radius 12, add shadow, 1px grey border", [r.card]);
  assert.equal(r.card.cornerRadius, 12);
  assert.equal(r.card.effects[0].type, "DROP_SHADOW");
  assert.equal(r.card.strokeWeight, 1);
  await r.apply("make the background #F5F5F5", [r.title]);
  assert.equal(Math.round(r.card.fills[0].color.r * 255), 0xF5, "background of a selected text layer is its parent");
});

test("a multi-part text edit loads every font before the first change, so it is one undo step", async () => {
  const r = runtime();
  const events: string[] = [];
  const realLoad = r.figma.loadFontAsync;
  r.figma.loadFontAsync = async (f: any) => { events.push("load " + f.style); return realLoad(f); };
  r.figma.commitUndo = () => { events.push("commit"); };
  await r.apply("make the title 24px bold", [r.card]);
  assert.equal(r.title.fontSize, 24);
  assert.deepEqual(plain(r.title.fontName), { family: "Inter", style: "Bold" });
  const first = events.indexOf("commit");
  const last = events.lastIndexOf("commit");
  assert.ok(first >= 0 && last > first, "edit is wrapped in commits: " + events.join(", "));
  assert.deepEqual(events.slice(first + 1, last).filter((e) => e.startsWith("load")), [], "no font loads between the commits: " + events.join(", "));
});

test("padding and spacing add auto layout when the frame has none", async () => {
  const r = runtime();
  const result = await r.apply("padding 24", [r.card]);
  assert.equal(r.card.layoutMode, "VERTICAL", "children stacked top to bottom → vertical");
  assert.equal(r.card.paddingLeft, 24);
  assert.match(result.notes.join(" "), /auto layout/);
  await r.apply("gap 12", [r.card]);
  assert.equal(r.card.itemSpacing, 12);
  await r.apply("center the items", [r.card]);
  assert.equal(r.card.counterAxisAlignItems, "CENTER");
  await r.apply("remove auto layout", [r.card]);
  assert.equal(r.card.layoutMode, "NONE");
});

test("layer actions, hidden layers and unknown targets", async () => {
  const r = runtime();
  await r.apply("delete hidden layers", [r.card]);
  assert.equal(r.hidden.removed, true);
  await r.apply("hide this", [r.body]);
  assert.equal(r.body.visible, false);
  await r.apply("duplicate this", [r.card]);
  assert.equal(r.screen.children.filter((c: any) => c.name === "Card copy").length, 1);
  const handover = await r.apply("make the avatar red", [r.screen]);
  assert.equal(handover.needsModel, true, "an unknown named target goes to the model instead of guessing");
  await assert.rejects(r.apply("padding 24", [r.title]), /has no padding/);
});

test("'the title' on a whole screen edits only the screen title, with every clause applied", async () => {
  const r = runtime();
  const header = r.make({ type: "FRAME", name: "Header", width: 375, height: 56, y: 0 }, r.screen);
  const screenTitle = r.make({ type: "TEXT", name: "Screen title", characters: "My Loans", fontSize: 20 }, header);
  const card2 = r.make({ type: "FRAME", name: "Card 2", width: 343, height: 200, y: 300 }, r.screen);
  const cardTitle = r.make({ type: "TEXT", name: "Card title", characters: "Personal Loan", fontSize: 16 }, card2);
  const result = await r.apply("make the title 24px and bold", [r.screen]);
  assert.equal(screenTitle.fontSize, 24);
  assert.deepEqual(plain(screenTitle.fontName), { family: "Inter", style: "Bold" });
  assert.equal(cardTitle.fontSize, 16, "card titles are untouched");
  assert.equal(r.title.fontSize, 20, "the card's own title is untouched");
  assert.equal(result.applied.length, 2, "both the size and the weight were applied");
  await r.apply("make all titles bold", [r.screen]);
  assert.deepEqual(plain(cardTitle.fontName), { family: "Inter", style: "Bold" }, "plural still hits every title");
});

test("from/to copy edits are applied in place, without a model or a new frame", async () => {
  const r = runtime();
  const ops = parse('Change the screen title from "Loan summary" to "My Loans"', FRAME);
  assert.ok(ops, "screen-title from/to is a direct edit");
  assert.ok(parse('rename "Loan summary" to "My Loans"', FRAME));
  assert.ok(parse('replace "Loan summary" with "My Loans"', FRAME));
  await r.apply('Change the screen title from "Loan summary" to "My Loans"', [r.screen]);
  assert.equal(r.title.characters, "My Loans");
  assert.equal(r.body.characters, "Pay ₹10,000 by 5 Dec", "layers without the text are not touched");
});


test("one new text never overwrites every text in a frame (finding 66)", () => {
  const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
  assert.ok(code.includes('if (op.set && typeof op.set.text === "string" && texts.length > 1) {'));
  assert.ok(code.includes("the new text would replace "));
});

test("state switch, wrap and component insert run without a model", async () => {
  const r = runtime();
  const withCriteria = (n: any) => { n.findAllWithCriteria = ({ types }: any) => n.findAll((c: any) => types.includes(c.type)); };
  [r.screen, r.card].forEach(withCriteria);
  r.page.findAll = (fn: any) => { const out: any[] = []; const walk = (x: any) => (x.children || []).forEach((c: any) => { if (fn(c)) out.push(c); walk(c); }); walk(r.page); return out; };
  withCriteria(r.page);
  const lib = r.make({ type: "FRAME", name: "Library", x: 1000 });
  const set: any = r.make({ type: "FRAME", name: "Button" }, lib);
  set.type = "COMPONENT_SET";
  const mk = (name: string) => {
    const c: any = r.make({ type: "COMPONENT", name }, set);
    c.createInstance = () => { const i = r.make({ type: "INSTANCE", name: "Button" }, r.page); i.getMainComponentAsync = async () => c; return i; };
    return c;
  };
  const primary = mk("Type=Primary, State=Default");
  mk("Type=Secondary, State=Default");
  const disabled = mk("Type=Primary, State=Disabled");
  set.defaultVariant = primary;
  set.componentPropertyDefinitions = { Type: { type: "VARIANT", variantOptions: ["Primary", "Secondary"] }, State: { type: "VARIANT", variantOptions: ["Default", "Disabled"] } };
  let props: any = null;
  r.button.getMainComponentAsync = async () => primary;
  r.button.setProperties = (p: any) => { props = p; };

  await r.apply("make this button disabled", [r.button]);
  assert.deepEqual(plain(props), { State: "Disabled" });
  await assert.rejects(r.apply("set the button to checked", [r.button]), /no "checked" variant/);
  assert.ok(disabled);

  const before = r.card.children.length;
  const result = await r.apply("add a primary button", [r.card]);
  assert.equal(r.card.children.length, before + 1, "instance placed inside the selected frame");
  const added = r.card.children[r.card.children.length - 1];
  assert.equal(added.type, "INSTANCE");
  assert.equal(await added.getMainComponentAsync(), primary, "picked the Primary variant, not a disabled one");
  assert.ok(added.y >= 148, "placed below the existing content");
  assert.match(JSON.stringify(result), /from your components/);
  await assert.rejects(r.apply("add a toggle", [r.card]), /No toggle component/);
});
