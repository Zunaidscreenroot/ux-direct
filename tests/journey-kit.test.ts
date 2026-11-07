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
