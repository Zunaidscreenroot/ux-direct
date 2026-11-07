/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory Figma mock is intentionally untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { runHygieneCheck, contrastRatio, formatHygieneReport } from "../src/figma-agent/hygiene-check";
import { deterministicLayerNames, normalizeTextEdits } from "../src/figma-agent/text-tasks";
import { normalizeUxAudit } from "../src/figma-agent/ux-audit-review";
import { enrichImagePrompt, targetImageSize } from "../src/figma-agent/image-services";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");

function loadClassifier(): (prompt: string, ctx: Record<string, unknown>) => any {
  const match = /\/\/ uxd-quick-task-classifier:start([\s\S]*?)\/\/ uxd-quick-task-classifier:end/.exec(ui);
  assert.ok(match, "classifier markers exist in ui.html");
  const sandbox: Record<string, any> = {};
  runInNewContext(match[1] + "\nthis.classifyQuickTask = classifyQuickTask;", sandbox);
  return sandbox.classifyQuickTask;
}

test("quick-task classifier routes Figma-agent style requests", () => {
  const classify = loadClassifier();
  const rect = { selectionTypes: ["RECTANGLE"] };
  const frame = { selectionTypes: ["FRAME"] };
  const texts = { selectionTypes: ["TEXT", "TEXT"] };
  assert.equal(classify("Insert image of a smiling woman holding a credit card", rect).kind, "generate-image");
  assert.equal(classify("insert image of a smiling woman holding a credit card", rect).description, "a smiling woman holding a credit card");
  assert.equal(classify("yahan ek mountain ki image daal do", rect).kind, "generate-image");
  assert.equal(classify("Insert image", { selectionTypes: ["RECTANGLE"], hasAttachment: true }), null, "attached images keep the existing insert path");
  assert.equal(classify("remove the background of this photo", rect).kind, "remove-background");
  assert.equal(classify("background hatao", rect).kind, "remove-background");
  assert.equal(classify("make this copy better and shorter", texts).kind, "rewrite-text");
  assert.equal(classify("add a line saying offer valid till 31 Dec", texts).kind, "rewrite-text");
  assert.equal(classify("rewrite the copy in this card to sound friendlier", frame).kind, "rewrite-text");
  assert.equal(classify("translate this screen to Hindi", frame).kind, "rewrite-text");
  assert.equal(classify("change the text colour to blue", texts), null, "style edits stay on the native action path");
  assert.equal(classify("make text white", { selectionTypes: ["TEXT"] }), null, "colour edits are not copy rewrites");
  assert.equal(classify("make this bold and bigger", { selectionTypes: ["TEXT"] }), null);
  assert.equal(classify("make this shorter", { selectionTypes: ["TEXT"] }).kind, "rewrite-text");
  assert.equal(classify("rename layers", frame).kind, "rename-layers");
  assert.equal(classify("do a UX audit of this flow", { selectionTypes: ["FRAME", "FRAME", "FRAME"] }).kind, "ux-audit");
  assert.equal(classify("run a hygiene check: auto layout, padding, consistency", frame).kind, "hygiene");
  assert.equal(classify("is the spacing consistent?", frame).kind, "hygiene");
  assert.equal(classify("create variations of this flow", { selectionTypes: ["FRAME", "FRAME", "FRAME"] }).kind, "flow-variations");
  const many = classify("make 3 variations of this screen", frame);
  assert.equal(many.kind, "screen-variations");
  assert.equal(many.count, 3);
  assert.equal(classify("create a variation of this screen", frame), null, "a single variation keeps the existing path");
  assert.equal(classify("improve this screen", frame), null);
  assert.equal(classify("add a primary button", frame), null);
});

test("revert and undo requests never reach a generation path", () => {
  const classify = loadClassifier();
  const frame = { selectionTypes: ["FRAME"] };
  for (const prompt of ["revert this change", "Revert the change", "undo", "undo that image", "roll back the last edit",
    "go back to the previous version", "restore the original", "isko wapas pehle jaisa kar do", "cancel the last change"]) {
    const task = classify(prompt, frame);
    assert.equal(task && task.kind, "revert", prompt);
  }
  assert.equal(classify("revert all changes", frame).all, true);
  assert.equal(classify("revert this change", frame).all, false);
  assert.ok(ui.includes('if (task.kind === "revert") return runRevertTask(task, stage);'));
  assert.ok(ui.includes("attachRevertButton(assistantMessage"), "each change message gets a revert button");
  assert.ok(/recordChange\("New screen/.test(ui), "generated screens are revertible");
});

test("ui.html wires quick tasks before the native and design paths", () => {
  const quickIndex = ui.indexOf("const quickTask = classifyQuickTask(");
  assert.ok(quickIndex > 0 && quickIndex < ui.indexOf("if (isDirectCanvasActionPrompt(prompt))"));
  for (const path of ["/api/assistant/figma-agent/image", "/api/assistant/figma-agent/text", "/api/assistant/figma-agent/audit"]) {
    assert.ok(ui.includes(path), path + " is called from the plugin");
  }
  assert.ok(ui.includes('message.type === "uxd-local-result"'));
  assert.ok(ui.includes("createFigmaDesign(job.prompt"), "variations reuse the verified design path");
});

test("hygiene check finds manual stacks, spacing drift, naming, contrast and touch targets", () => {
  const report = runHygieneCheck({
    nodes: [{
      id: "1", type: "FRAME", name: "Home", x: 0, y: 0, width: 390, height: 800, fillColors: ["#FFFFFF"],
      children: [
        { id: "2", type: "FRAME", name: "Frame 12", x: 0, y: 0, width: 390, height: 200, children: [
          { id: "3", type: "TEXT", name: "Title", x: 16, y: 16, width: 200, height: 24, text: "Hello", fontSize: 20, fillColors: ["#DDDDDD"] },
          { id: "4", type: "TEXT", name: "Sub", x: 16, y: 50, width: 200, height: 20, text: "World", fontSize: 10, fillColors: ["#111111"] },
        ] },
        { id: "5", type: "FRAME", name: "Row", layoutMode: "HORIZONTAL", x: 0, y: 220, width: 390, height: 56, paddingLeft: 16, paddingRight: 13, paddingTop: 8, paddingBottom: 8, itemSpacing: 12, children: [] },
        { id: "6", type: "FRAME", name: "Row", layoutMode: "HORIZONTAL", x: 0, y: 280, width: 390, height: 64, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, itemSpacing: 8, children: [] },
        { id: "7", type: "INSTANCE", name: "Close button", x: 340, y: 10, width: 24, height: 24 },
        { id: "8", type: "RECTANGLE", name: "Old", visible: false, x: 0, y: 0, width: 10, height: 10 },
      ],
    }],
  }, { textStyles: 3 });
  const rules = report.issues.map((issue) => issue.rule);
  for (const rule of ["auto-layout", "spacing-grid", "padding-symmetry", "repeated-item-drift", "layer-names", "hidden-layers", "text-styles", "small-text", "touch-target", "contrast"]) {
    assert.ok(rules.includes(rule), "expected " + rule + " in " + rules.join(","));
  }
  assert.equal(report.issues[0].severity, "high", "contrast failure below 3:1 is ranked first");
  assert.ok(report.score < 60);
  assert.match(formatHygieneReport(report), /UI hygiene score/);
  const clean = runHygieneCheck({ nodes: [{ id: "1", type: "FRAME", name: "Card", layoutMode: "VERTICAL", paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16, itemSpacing: 8, fillColors: ["#FFFFFF"],
    children: [{ id: "2", type: "TEXT", name: "Label", text: "Pay", fontSize: 16, fillColors: ["#111111"] }] }] });
  assert.equal(clean.issues.length, 0);
  assert.equal(clean.score, 100);
  assert.ok(Math.abs(contrastRatio("#000000", "#FFFFFF")! - 21) < 0.01);
});

test("make text white routes to the native action path", () => {
  const match = /function isDirectCanvasActionPrompt\(prompt\) \{[\s\S]*?\n    \}\n/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[0] + "\nthis.f = isDirectCanvasActionPrompt;", sandbox);
  assert.equal(sandbox.f("make text white"), true);
  assert.equal(sandbox.f("turn the button blue"), true);
  assert.equal(sandbox.f("make a dark mode version of this screen"), false);
});

test("native-action prompts from the plugin test route to the native action path", () => {
  const match = /function isDirectCanvasActionPrompt\(prompt\) \{[\s\S]*?\n    \}\n/.exec(ui);
  assert.ok(match);
  const sandbox: Record<string, any> = {};
  runInNewContext(match[0] + "\nthis.f = isDirectCanvasActionPrompt;", sandbox);
  // Each of these used to fall through to the full variation pipeline or plain chat.
  for (const prompt of [
    "add a primary button",
    "insert a small outline icon",
    "add a soft shadow to the card",
    "add a subtle gradient background",
    "give the card a border",
    "make this button disabled",
    "set the tab to active",
    "wrap these rows in auto layout",
    "hide the Others tab",
    "Others tab ko hide karo",
    "show the Others tab again",
    "lock the header",
    "unlock this layer",
    "set the card opacity to 50%",
    "rename the second tab to Loans",
    "resize the button to 48 high",
    "change the first loan card status to Overdue",
    "make the first card's status Overdue",
    "set the badge type to warning",
    "switch the button size to small",
  ]) assert.equal(sandbox.f(prompt), true, prompt);
  // Questions and new content with the same words are not layer edits.
  for (const prompt of ["show me what you can do", "how do I hide a layer?", "create a login screen with a lock icon"])
    assert.equal(sandbox.f(prompt), false, prompt);
  // Screen-level work stays on the variation / quick-task paths.
  for (const prompt of [
    "add empty, loading and error states",
    "add a new onboarding screen",
    "improve this screen",
    "create 3 variations of this card",
  ]) assert.equal(sandbox.f(prompt), false, prompt);
});

test("text edits accept refs, bare arrays, maps and single answers", () => {
  const items = [{ id: "123:4567;89:10", type: "TEXT", name: "Title", text: "Hi" }, { id: "2:2", type: "TEXT", name: "Body", text: "Old" }];
  assert.deepEqual(normalizeTextEdits("rewrite", { updates: [{ ref: "t1", text: "Hello" }] }, items).map((e) => e.id), ["123:4567;89:10"]);
  assert.deepEqual(normalizeTextEdits("rewrite", {}, items, '```json\n[{"ref":"t2","text":"New"}]\n```').map((e) => e.value), ["New"]);
  assert.deepEqual(normalizeTextEdits("rewrite", { t1: "Hey", t2: { text: "Body copy" } }, items).map((e) => e.value), ["Hey", "Body copy"]);
  assert.deepEqual(normalizeTextEdits("rewrite", { result: [{ layer: "Body", new_text: "Fresh" }] }, items).map((e) => e.value), ["Fresh"]);
  assert.deepEqual(normalizeTextEdits("rewrite", { text: "Only one" }, [items[0]]).map((e) => e.value), ["Only one"]);
});

test("rename falls back to rule-based names for default-named layers", () => {
  const names = deterministicLayerNames([
    { id: "1", type: "FRAME", name: "Frame 12", hint: "text: Pay ₹10,000 size: 340x48" },
    { id: "2", type: "VECTOR", name: "Vector", hint: "size: 24x24" },
    { id: "3", type: "FRAME", name: "Header", hint: "text: Hi" },
  ]);
  assert.deepEqual(names.map((e) => e.value), ["Pay ₹10,000 Button", "Icon"]);
});

test("text edits keep only real changes to known layers", () => {
  const items = [{ id: "1", type: "TEXT", name: "Title", text: "Hi" }, { id: "2", type: "FRAME", name: "Frame 3" }];
  assert.deepEqual(normalizeTextEdits("rewrite", { updates: [{ id: "1", text: "Welcome back" }, { id: "9", text: "x" }, { id: "2", text: "no" }, { id: "1", text: "dup" }] }, items),
    [{ id: "1", value: "Welcome back", before: "Hi" }]);
  assert.deepEqual(normalizeTextEdits("rename", { names: [{ id: "2", name: "  Loan   Card " }, { id: "1", name: "Title" }] }, items),
    [{ id: "2", value: "Loan Card", before: "Frame 3" }]);
  assert.deepEqual(normalizeTextEdits("rewrite", { updates: [{ id: "1", text: "Hi" }] }, items), [], "unchanged text is dropped");
});

test("UX audit normalizes free-model variants of the schema", () => {
  const audit = normalizeUxAudit({ overview: "ok", score: 7, issues: [
    { priority: "minor", problem: "Label is vague", recommendation: "Say Pay ₹4,500" },
    { severity: "critical", issue: "No back button", fix: "Add back navigation", nodeId: "12:3" },
    { severity: "high", issue: "missing fix" },
  ] });
  assert.ok(audit);
  assert.equal(audit!.score, 70, "0-10 scores are scaled");
  assert.equal(audit!.findings.length, 2);
  assert.equal(audit!.findings[0].severity, "high");
  assert.equal(audit!.findings[0].nodeId, "12:3");
  assert.equal(normalizeUxAudit({ summary: "x", findings: [] }), null);
});

test("generated images keep the shape's aspect ratio at up to 2x", () => {
  assert.deepEqual(targetImageSize(343, 180), { width: 686, height: 360 });
  assert.deepEqual(targetImageSize(1440, 600), { width: 2048, height: 853 });
  assert.match(enrichImagePrompt("a beach", 1200, 400), /wide landscape/);
  assert.match(enrichImagePrompt("a beach", 300, 600), /tall portrait/);
  assert.match(enrichImagePrompt("a beach", 300, 300), /no text/);
  assert.doesNotMatch(enrichImagePrompt("a logo with the text SALE", 300, 300), /no text/);
});

function makeRuntime() {
  let next = 1;
  const created: any[] = [];
  const page: any = { id: "0:1", type: "PAGE", name: "Page 1", children: [], selection: [] };
  const node = (props: any) => {
    const item = { id: "1:" + next++, visible: true, x: 0, y: 0, width: 100, height: 100, fills: [], parent: page, ...props };
    if (item.children) item.children.forEach((child: any) => { child.parent = item; });
    return item;
  };
  const photo = node({ type: "RECTANGLE", name: "Photo", width: 320, height: 200,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }, { type: "IMAGE", imageHash: "old", scaleMode: "FIT", visible: true }] });
  const label = node({ type: "TEXT", name: "Label", characters: "Hi", fontSize: 14 });
  const card = node({ type: "FRAME", name: "Card", layoutMode: "VERTICAL", fillStyleId: "S:1", children: [photo, label] });
  const made: any = node({ type: "FRAME", name: "Variation", getPluginData: (key: string) => (key === "uxdCreated" ? "1" : "") });
  made.remove = () => { page.children.splice(page.children.indexOf(made), 1); made.removed = true; };
  page.children.push(card, made);
  const all = [card, photo, label, made];
  const posted: any[] = [];
  const figma: any = {
    fileKey: /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1], currentPage: page, root: { children: [page] }, mixed: Symbol("mixed"),
    viewport: { zoom: 1, bounds: {} }, ui: { postMessage: (message: any) => posted.push(message), onmessage: null },
    showUI() {}, on() {}, closePlugin() {}, commitUndo() {},
    getNodeByIdAsync: async (id: string) => all.find((item) => item.id === id) || null,
    getImageByHash: (hash: string) => (hash === "old" ? { getBytesAsync: async () => new Uint8Array([1, 2, 3, 4]) } : null),
    createImage: (bytes: Uint8Array) => { created.push(bytes); return { hash: "new-" + bytes.length }; },
    getLocalPaintStylesAsync: async () => [{ id: "S:1" }], getLocalTextStylesAsync: async () => [],
    variables: { getLocalVariablesAsync: async () => [] },
  };
  page.selection = [card];
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  async function local(op: string, payload: any) {
    posted.length = 0;
    await figma.ui.onmessage({ type: "uxd-local-task", requestId: "r1", op, payload });
    const message = posted.find((item) => item.type === "uxd-local-result");
    if (message.error) throw new Error(message.error);
    return message.result;
  }
  return { local, photo, label, card, created, made, page };
}

test("local quick-task channel reads trees and images and applies image fills in code.js", async () => {
  const { local, photo, label, card, created, made, page } = makeRuntime();
  const tree = await local("read-tree", { maxDepth: 3 });
  assert.equal(tree.nodes[0].id, card.id);
  assert.equal(tree.nodes[0].fillStyled, true);
  assert.equal(tree.nodes[0].children[0].imageFill, true);
  assert.equal(tree.styleCounts.paint, 1);
  const image = await local("read-image", { nodeId: photo.id });
  assert.equal(image.source, "image-fill");
  assert.equal(image.scaleMode, "FIT");
  assert.deepEqual([...image.bytes], [1, 2, 3, 4]);
  const bytes = new Uint8Array(32).fill(7);
  const replaced = await local("apply-image", { nodeId: photo.id, bytes, mode: "replace-image" });
  assert.equal(replaced.replaced, true);
  assert.equal(photo.fills.length, 2, "other fills are kept when replacing the image");
  assert.equal(photo.fills[1].imageHash, "new-32");
  assert.equal(photo.fills[1].scaleMode, "FIT");
  assert.equal(created.length, 1);
  await assert.rejects(local("apply-image", { nodeId: label.id, bytes }), /not a text layer/);
  await assert.rejects(local("delete-everything", {}), /Unsupported local task/);
  await local("restore-fills", { snapshotId: replaced.snapshotId });
  assert.equal(photo.fills[1].imageHash, "old", "revert restores the fills captured before the change");
  await assert.rejects(local("restore-fills", { snapshotId: replaced.snapshotId }), /saved state/);
  await assert.rejects(local("delete-created", { nodeIds: [card.id] }), /not created by UX Direct/);
  const removed = await local("delete-created", { nodeIds: [made.id] });
  assert.deepEqual([...removed.deleted], ["Variation"]);
  assert.equal(page.children.includes(made), false);
});

test("instances that differ by variant get a manual low finding, not the auto-fixable drift", () => {
  const card = (id: string, layoutMode: string, height: number) => ({ id, type: "INSTANCE", name: "Loan Card", layoutMode, x: 0, y: 0, width: 343, height, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16, itemSpacing: 8, children: [] });
  const report = runHygieneCheck({ nodes: [{ id: "1", type: "FRAME", name: "Loans", layoutMode: "VERTICAL", x: 0, y: 0, width: 375, height: 800, children: [
    card("2", "HORIZONTAL", 144), card("3", "VERTICAL", 198), card("4", "VERTICAL", 198),
  ] }] });
  const rules = report.issues.map((issue) => issue.rule);
  assert.ok(!rules.includes("repeated-item-drift"));
  const finding = report.issues.find((issue) => issue.rule === "repeated-instance-variants");
  assert.equal(finding?.severity, "low");
  assert.match(String(finding?.evidence), /"Loan Card" ×3/);
});

test("copy rewrite drops whitespace-only edits and leaves IDs, amounts and dates alone unless asked", async () => {
  const { isValueText } = await import("../src/figma-agent/text-tasks");
  const items = [
    { id: "a", type: "TEXT", name: "Title", text: "Manage Loans" },
    { id: "b", type: "TEXT", name: "Product", text: "Personal Loan " },
    { id: "c", type: "TEXT", name: "Ref", text: "DMI1234567890" },
    { id: "d", type: "TEXT", name: "Pct", text: "60%" },
  ];
  const updates = { updates: [
    { ref: "t1", text: "Loans Overview" }, { ref: "t2", text: "Personal Loan" },
    { ref: "t3", text: "DMI 1234567890" }, { ref: "t4", text: "60% Paid" },
  ] };
  assert.deepEqual(normalizeTextEdits("rewrite", updates, items, "", "rewrite the copy on this screen to be clearer").map((e) => e.id), ["a"]);
  assert.deepEqual(normalizeTextEdits("rewrite", updates, items, "", "format the amounts and ids").map((e) => e.id), ["a", "c", "d"]);
  assert.equal(isValueText("₹1,07,649"), true);
  assert.equal(isValueText("12 Nov 2026"), true);
  assert.equal(isValueText("Pay ₹4,500"), false);
  assert.equal(isValueText("Apply now"), false);
});

test("copy rewrite drops punctuation-only edits unless the request is about punctuation", () => {
  const items = [
    { id: "a", type: "TEXT", name: "Alert", text: "Late EMIs incur penalties and lower your score." },
    { id: "b", type: "TEXT", name: "Banner", text: "Pay your due charges now to close this loan off" },
  ];
  const updates = { updates: [
    { ref: "t1", text: "Late EMIs incur penalties and lower your score" },
    { ref: "t2", text: "Pay due charges now to close this loan" },
  ] };
  assert.deepEqual(normalizeTextEdits("rewrite", updates, items, "", "rewrite the text on this screen to be clearer").map((e) => e.id), ["b"]);
  assert.deepEqual(normalizeTextEdits("rewrite", updates, items, "", "remove the full stops").map((e) => e.id), ["a", "b"]);
});

test("copy rewrite keeps the screen title and tab label widths unless asked", () => {
  const items = [
    { id: "a", type: "TEXT", name: "Manage Loans", parent: "App bar", text: "Manage Loans" },
    { id: "b", type: "TEXT", name: "Tab label · Others", parent: "Tab · Others", text: "Others" },
    { id: "c", type: "TEXT", name: "Stat label", parent: "Stat · Charges Due", text: "Charges Due" },
    { id: "d", type: "TEXT", name: "Tab label · Closed", parent: "Tab · Closed", text: "Closed" },
  ];
  const updates = { updates: [
    { ref: "t1", text: "Loan Management" }, { ref: "t2", text: "Other Loans" },
    { ref: "t3", text: "Amount Due" }, { ref: "t4", text: "Closed ✓" },
  ] };
  assert.deepEqual(normalizeTextEdits("rewrite", updates, items, "", "rewrite the text on this screen to be clearer").map((e) => e.id), ["c", "d"]);
  assert.deepEqual(normalizeTextEdits("rewrite", updates, items, "", "make the title and tabs clearer, longer is fine").map((e) => e.id), ["a", "b", "c", "d"]);
  // The title inside an instance's own frame is still caught by matching the screen name.
  const nested = [{ id: "a", type: "TEXT", name: "Text", parent: "Left", text: "Manage Loans" }];
  assert.deepEqual(normalizeTextEdits("rewrite", { updates: [{ ref: "t1", text: "Loan Management" }] }, nested, "", "make it clearer", "Manage Loans"), []);
});

test("copy rewrite: plain-header title, no topic repetition, standard abbreviations, one label case", async () => {
  const { inferScreenTitleId, dominantLabelCase } = await import("../src/figma-agent/text-tasks");
  const settings = [
    { id: "t", type: "TEXT", name: "Settings", parent: "Frame 12", text: "Settings", fontSize: 24 },
    { id: "n", type: "TEXT", name: "Row", parent: "Row", text: "Notifications", fontSize: 16 },
    { id: "p", type: "TEXT", name: "Row", parent: "Row", text: "Privacy", fontSize: 16 },
    { id: "h", type: "TEXT", name: "Row", parent: "Row", text: "Help & support", fontSize: 16 },
    { id: "a", type: "TEXT", name: "Row", parent: "Row", text: "About this app", fontSize: 16 },
    { id: "d", type: "TEXT", name: "Row", parent: "Row", text: "Delete account", fontSize: 16 },
  ];
  assert.equal(inferScreenTitleId(settings), "t");
  assert.equal(dominantLabelCase(settings.map((i) => i.text)), "sentence");
  const out = normalizeTextEdits("rewrite", { updates: [
    { ref: "t1", text: "App Settings" }, { ref: "t2", text: "Alerts and reminders" }, { ref: "t3", text: "Privacy settings" },
    { ref: "t4", text: "Help & Support Center" },
  ] }, settings, "", "rewrite the text on this screen to be clearer");
  assert.deepEqual(out.map((e) => [e.id, e.value]), [["n", "Alerts and reminders"], ["h", "Help & support center"]]);

  const cart = [
    { id: "c", type: "TEXT", name: "Title", parent: "Header", text: "Your Cart", fontSize: 22 },
    { id: "q", type: "TEXT", name: "Meta", parent: "Item", text: "Qty 1", fontSize: 13 },
    { id: "s", type: "TEXT", name: "Link", parent: "Footer", text: "continue shopping", fontSize: 14 },
  ];
  const cartOut = normalizeTextEdits("rewrite", { updates: [{ ref: "t2", text: "Quantity: 1" }, { ref: "t3", text: "Keep shopping" }] }, cart, "", "make it clearer");
  assert.deepEqual(cartOut.map((e) => [e.id, e.value]), [["s", "Keep shopping"]]);
});

test("property-only native edits verify by read-back and scoped repairs never touch other nodes", () => {
  assert.ok(ui.includes("const PROPERTY_ONLY_KEYS = [\"visible\", \"locked\", \"name\", \"opacity\""), "property-only edit list");
  assert.ok(/if \(propertyOnly\) \{[\s\S]*?read-back passed[\s\S]*?\n      \}/.test(ui), "property-only edits return before screenshot QA");
  assert.ok(ui.indexOf("if (propertyOnly) {") < ui.indexOf("const qa = await runVisualQualityLoop({\n          prompt: prompt, sourceCanvas: canvas"), "read-back path runs before visual QA");
  assert.ok(ui.includes("if (!inScope(item.nodeId)) continue;"), "repairs stay inside the edit's target set");
  assert.ok(ui.includes("targetScope: targetScope"), "native edits pass their target scope to the repair loop");
});
