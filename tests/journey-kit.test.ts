import { test } from "node:test";
import assert from "node:assert/strict";
import { expandBlockSpec, findButtonComponent, pinActionsToBottom } from "../src/figma-agent/block-spec";
import { createModeCanvas } from "../src/figma-agent/create-mode";
import { providerBody } from "../src/llm-gateway/router";
import { PROVIDERS } from "../src/llm-gateway/catalog";

type N = Record<string, unknown> & { type: string; name: string; children?: N[] };
const all = (nodes: N[]): N[] => nodes.flatMap((n) => [n, ...all(n.children ?? [])]);

const spec = {
  summary: "Choose how to pay the overdue EMI.",
  frame: { name: "Payment method" },
  sections: [
    { name: "Header", surface: "plain", blocks: [{ type: "app_bar", title: "Payment method", back: true }] },
    { name: "Amount", surface: "card", blocks: [{ type: "stat", label: "Amount due", value: "₹12,500" }] },
    { name: "Actions", surface: "plain", blocks: [{ type: "buttons", items: [{ label: "Pay ₹12,500", variant: "primary" }, { label: "Cancel", variant: "secondary" }] }] },
  ],
};

test("journey kit: later screens reuse the first screen's exact app bar and primary button", () => {
  const kit = { header: { id: "10:1", name: "App bar / Back", width: 393, height: 56 }, button: { id: "20:2", name: "Button / Primary", width: 361, height: 48 } };
  const canvas = createModeCanvas({ nodes: [], components: [{ id: "99:9", name: "Card", width: 300, height: 200 }] }, { width: 393, height: 852 }, "create payment method", kit);
  const comps = canvas.components as Array<Record<string, unknown>>;
  assert.deepEqual(comps.slice(0, 2).map((c) => c.id), ["10:1", "20:2"]);
  const out = expandBlockSpec(spec, canvas, { create: true, kitButtonId: "20:2" });
  assert.ok(out.plan, out.errors.join("; "));
  const nodes = all(out.plan!.elements as N[]);
  const header = nodes.find((n) => n.type === "INSTANCE" && n.componentId === "10:1");
  assert.ok(header, "app bar is the kit's instance");
  const button = nodes.find((n) => n.type === "INSTANCE" && n.componentId === "20:2");
  assert.ok(button, "primary action is the kit's button instance");
  assert.deepEqual(button!.textOverrides, { __title: "Pay ₹12,500" });
  // The secondary action stays drawn: its variant cannot be picked safely.
  assert.ok(nodes.some((n) => n.type === "FRAME" && /Secondary button/.test(n.name)));
});

test("create mode uses the file's primary button variant from the catalogue", () => {
  const found = findButtonComponent([
    { id: "1:1", name: "Icon button", height: 40, properties: {} },
    { id: "2:2", name: "Button", height: 48, properties: { Type: { type: "VARIANT", options: ["Primary", "Secondary"] }, State: { type: "VARIANT", options: ["Default", "Disabled"] } } },
  ]);
  assert.deepEqual(found, { id: "2:2", height: 48, instanceProperties: { Type: "Primary", State: "Default" } });
  assert.equal(findButtonComponent([{ id: "3:3", name: "Button", height: 48, properties: { Type: { type: "VARIANT", options: ["Ghost", "Outline"] } } }]), null);
  // Improve keeps its drawn buttons.
  const out = expandBlockSpec(spec, { nodes: [{ id: "1", type: "FRAME", name: "S", width: 360, height: 800, children: [] }], components: [{ id: "2:2", name: "Primary button", height: 48 }] }, {});
  assert.ok(!all(out.plan!.elements as N[]).some((n) => n.type === "INSTANCE" && n.componentId === "2:2"));
});

test("a short new screen keeps its actions at the bottom of the frame", () => {
  const canvas = createModeCanvas({ nodes: [], components: [] }, { width: 360, height: 800 }, "create payment method");
  const out = expandBlockSpec(spec, canvas, { create: true });
  const last = out.plan!.elements[out.plan!.elements.length - 1] as N;
  assert.equal(last.primaryAxisAlignItems, "MAX");
  assert.equal(out.plan!.frame.height, 800);
  assert.equal(pinActionsToBottom([{ type: "FRAME", name: "Bottom navigation", layoutMode: "VERTICAL", noFill: true, width: 1, height: 1 }], 300), false);
});

test("result_icon renders a centred status icon in the screen's tone", () => {
  const canvas = createModeCanvas({ nodes: [], components: [] }, { width: 360, height: 800 }, "payment failed");
  const out = expandBlockSpec({ summary: "Payment failed state.", sections: [
    { name: "Result", surface: "plain", blocks: [{ type: "result_icon", tone: "danger" }, { type: "heading", title: "Payment failed" }] },
    { name: "Actions", surface: "plain", blocks: [{ type: "button", label: "Retry", variant: "primary" }] },
  ] }, canvas, { create: true });
  assert.ok(out.plan, out.errors.join("; "));
  const nodes = all(out.plan!.elements as N[]);
  const icon = nodes.find((n) => n.name === "Error icon");
  assert.ok(icon && icon.width === 56);
  assert.ok(nodes.some((n) => n.type === "TEXT" && n.text === "!"));
});

test("JSON mode always mentions json, so Groq does not refuse the request", () => {
  const groq = PROVIDERS.find((p) => p.id === "groq")!;
  const body = { messages: [{ role: "system", content: "Plan the journey." }, { role: "user", content: "{\"request\":\"x\"}" }], response_format: { type: "json_object" } };
  const out = providerBody(groq, "openai/gpt-oss-120b", body, true);
  assert.equal((out.messages as unknown[]).length, 3);
  const ok = providerBody(groq, "openai/gpt-oss-120b", { ...body, messages: [{ role: "system", content: "Return JSON." }] }, true);
  assert.equal((ok.messages as unknown[]).length, 1);
});

test("a journey screen shows its own title in the kit app bar, with the first screen's gutter and background", () => {
  const kit = { header: { id: "10:1", name: "App bar", width: 393, height: 56 }, title: "Confirm payment", gutter: 20, background: "#F4F6FA" };
  const canvas = createModeCanvas({ nodes: [], components: [] }, { width: 393, height: 852 }, "confirm", kit);
  const noBar = { summary: "Confirm the payment.", theme: { background: "#FFFFFF" }, sections: [
    { name: "Summary", surface: "card", blocks: [{ type: "stat", label: "Amount", value: "₹12,570" }] },
    { name: "Actions", surface: "plain", blocks: [{ type: "button", label: "Confirm and pay", variant: "primary" }] },
  ] };
  const out = expandBlockSpec(noBar, canvas, { create: true, screenTitle: "Confirm payment", gutter: 20, background: "#F4F6FA" });
  assert.ok(out.plan, out.errors.join("; "));
  const header = all(out.plan!.elements as N[]).find((n) => n.type === "INSTANCE" && n.componentId === "10:1");
  assert.ok(header, "app bar added even though the model left it out");
  assert.equal((header!.textOverrides as Record<string, string>).__title, "Confirm payment");
  assert.equal(out.plan!.frame.backgroundColor, "#F4F6FA");
  const sections = out.plan!.elements.slice(1) as N[];
  assert.ok(sections.every((n) => n.paddingLeft === 20 || n.x === 20), "every section sits on the 20px gutter");
});

test("an alert keeps its short CTA inline in a plain section, and a screen has one app bar", () => {
  const canvas = createModeCanvas({ nodes: [], components: [{ id: "10:1", name: "App bar", width: 360, height: 64 }, { id: "30:3", name: "Loan Card", width: 320, height: 220 }] }, { width: 360, height: 800 }, "loans");
  const out = expandBlockSpec({ summary: "Loans with an overdue alert.", sections: [
    { name: "Header", surface: "plain", blocks: [{ type: "app_bar", title: "Manage loans" }] },
    { name: "Alert", surface: "plain", blocks: [{ type: "banner", title: "₹12,570 overdue", tone: "danger" }, { type: "button", label: "Pay now", variant: "primary" }] },
    { name: "Loans", surface: "plain", blocks: [{ type: "app_bar", title: "Manage Loan" }, { type: "component", componentId: "10:1", name: "App bar" }, { type: "component", componentId: "30:3", name: "Loan Card" }] },
  ] }, canvas, { create: true });
  assert.ok(out.plan, out.errors.join("; "));
  const nodes = all(out.plan!.elements as N[]);
  const pay = nodes.find((n) => n.name === "Button / Primary");
  assert.ok(pay && pay.height === 36, "inline compact CTA");
  assert.equal(nodes.filter((n) => n.type === "INSTANCE" && n.componentId === "10:1").length, 1, "one app bar instance");
  assert.ok(!nodes.some((n) => /App bar · Manage Loan/.test(n.name)), "no second hand-drawn app bar");
  const card = nodes.find((n) => n.componentId === "30:3");
  assert.equal(card!.height, 220, "instance keeps its own height");
});

test("improve shows a source string no more often than the source, and drops invented layer-name text", async () => {
  const { dedupeImproveTexts } = await import("../src/figma-agent/block-spec");
  const t = (text: string): N => ({ type: "TEXT", name: "Text", text, width: 100, height: 20 });
  const card = (kids: N[]): N => ({ type: "FRAME", name: "Card", color: "#FFFFFF", cornerRadius: 12, width: 320, height: 100, children: kids });
  const elements: N[] = [
    { type: "FRAME", name: "Header", noFill: true, width: 360, height: 64, children: [{ type: "FRAME", name: "App bar · Manage Loans", width: 360, height: 64, children: [t("Manage Loans")] }] },
    { type: "FRAME", name: "Title", noFill: true, width: 360, height: 30, children: [t("Manage Loans")] },
    card([t("Personal Loan"), t("Personal Loan"), t("slice"), { type: "FRAME", name: "Primary button", width: 80, height: 36, children: [t("Pay now")] }, t("Pay now")]),
  ];
  const counts = new Map([["manage loans", 1], ["personal loan", 1], ["pay now", 1]]);
  const removed = dedupeImproveTexts(elements as unknown as Parameters<typeof dedupeImproveTexts>[0], counts, []);
  assert.equal(removed, 4);
  assert.equal(elements[1].children!.length, 0);
  assert.deepEqual(elements[2].children!.map((n) => n.type === "TEXT" ? n.text : n.name), ["Personal Loan", "Primary button"]);
});

test("the journey kit button keeps the first screen's variant, not its label", () => {
  const found = findButtonComponent([{ id: "5:5", name: "Button", height: 48, properties: { Type: { type: "VARIANT", options: ["Primary", "Secondary"] }, Label: { type: "TEXT" } } }], "5:5", { Type: "Primary", Label: "Pay now", State: "Default" });
  assert.deepEqual(found, { id: "5:5", height: 48, instanceProperties: { Type: "Primary", State: "Default" } });
});

test("a component block carries its own words and hides the component's placeholder copy", () => {
  const canvas = createModeCanvas({ nodes: [], components: [{ id: "30:3", name: "Chip", width: 120, height: 32 }] }, { width: 360, height: 800 }, "create confirm screen");
  const out = expandBlockSpec({ summary: "Confirm the payment.", frame: { name: "Confirm" }, sections: [
    { name: "Details", surface: "card", blocks: [{ type: "component", componentId: "30:3", text: "Delinquent" }] },
  ] }, canvas, { create: true });
  assert.ok(out.plan, out.errors.join("; "));
  const chip = all(out.plan!.elements as N[]).find((n) => n.type === "INSTANCE" && n.componentId === "30:3");
  assert.ok(chip);
  assert.deepEqual(chip!.textOverrides, { __title: "Delinquent" });
  assert.equal(chip!.hidePlaceholderTexts, true);
});

test("a kit button drawn with touch padding (up to 72px) is still the file's button", () => {
  const found = findButtonComponent([{ id: "5:5", name: "Benchmark / Button", height: 67, properties: { Variant: { type: "VARIANT", options: ["Primary", "Secondary"] } } }]);
  assert.equal(found?.id, "5:5");
  assert.deepEqual(found?.instanceProperties, { Variant: "Primary" });
});
