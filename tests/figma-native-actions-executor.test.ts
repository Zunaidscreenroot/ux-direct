/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory Figma mock is intentionally untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { FIGMA_CANVAS_COMMANDS } from "../src/figma-agent/command-registry";
import { extendedActionIssues, NATIVE_REACTION } from "../src/figma-agent/native-action-schema";

/**
 * Runs the real figma-plugin/code.js inside a VM against a small in-memory Figma mock,
 * so the new native actions are exercised end to end rather than by string matching.
 */
const source = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
const FILE_KEY = /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(source)![1];

type MockNode = Record<string, any>;
let nextId = 1;

function makeNode(type: string, props: MockNode = {}): MockNode {
  const node: MockNode = {
    id: "1:" + nextId++, type, name: type, visible: true, x: 0, y: 0, width: 100, height: 40, parent: null,
    fills: [], strokes: [], effects: [], opacity: 1, rotation: 0, ...props,
  };
  node.remove = () => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; };
  node.resize = (w: number, h: number) => { node.width = w; node.height = h; };
  if (["FRAME", "PAGE", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].includes(type)) {
    node.children = node.children || [];
    node.layoutMode = node.layoutMode || "NONE";
    node.insertChild = (index: number, child: MockNode) => {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      node.children.splice(index, 0, child); child.parent = node;
    };
    node.appendChild = (child: MockNode) => node.insertChild(node.children.length, child);
    node.layoutGrids = [];
  }
  if (type === "COMPONENT") {
    node.createInstance = () => {
      const instance = makeNode("INSTANCE", { width: node.width, height: node.height, name: node.name });
      instance.mainComponentId = node.id;
      instance.componentProperties = JSON.parse(JSON.stringify(node.instanceDefaults || {}));
      instance.setProperties = (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) instance.componentProperties[key].value = value;
      };
      return instance;
    };
  }
  if (type === "COMPONENT" || type === "COMPONENT_SET") {
    node.componentPropertyDefinitions = {};
    node.addComponentProperty = (name: string, kind: string, defaultValue: unknown) => {
      const key = name + "#9:" + nextId++;
      node.componentPropertyDefinitions[key] = { type: kind, defaultValue };
      return key;
    };
  }
  node.reactions = [];
  node.setReactionsAsync = async (reactions: unknown[]) => { node.reactions = reactions; };
  return node;
}

function walk(node: MockNode, visit: (n: MockNode) => void) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function createRuntime() {
  nextId = 1;
  const page = makeNode("PAGE", { name: "Page 1", flowStartingPoints: [] });
  page.selection = [];
  page.findOne = (predicate: (n: MockNode) => boolean) => {
    let found: MockNode | null = null;
    for (const child of page.children) walk(child, (n) => { if (!found && predicate(n)) found = n; });
    return found;
  };
  page.findAll = (predicate: (n: MockNode) => boolean) => {
    const out: MockNode[] = [];
    for (const child of page.children) walk(child, (n) => { if (predicate(n)) out.push(n); });
    return out;
  };
  page.findAllWithCriteria = ({ types }: { types: string[] }) => page.findAll((n: MockNode) => types.includes(n.type));
  page.loadAsync = async () => {};
  const posted: any[] = [];
  const ui: MockNode = { postMessage: (message: unknown) => posted.push(message), onmessage: null };
  const figma: MockNode = {
    fileKey: FILE_KEY, ui, currentPage: page, root: { children: [page] }, mixed: Symbol("mixed"),
    viewport: { center: { x: 0, y: 0 }, zoom: 1, bounds: {} },
    showUI() {}, on() {}, closePlugin() {},
    createFrame: () => makeNode("FRAME"),
    createRectangle: () => makeNode("RECTANGLE"),
    createText: () => makeNode("TEXT", { characters: "" }),
    loadFontAsync: async () => {},
    getNodeByIdAsync: async (id: string) => page.findOne((n: MockNode) => n.id === id),
    getLocalPaintStylesAsync: async () => figma.__paintStyles,
    getLocalTextStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalGridStylesAsync: async () => [],
    createPaintStyle: () => { const style = { id: "S:" + nextId++, name: "", paints: [] }; return style; },
    __paintStyles: [] as MockNode[],
  };
  runInNewContext(source, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, setTimeout, clearTimeout });
  async function write(payload: Record<string, unknown>) {
    posted.length = 0;
    await ui.onmessage({ type: "run-canvas-command", command: { commandId: "cmd-" + nextId, action: "write-canvas", payload: { confirm: true, ...payload } } });
    const message = posted.find((m) => m && m.type === "canvas-command-result");
    if (message.error) throw new Error(message.error);
    return message.result;
  }
  return { figma, page, write };
}

test("every registry command has a native executor branch", () => {
  for (const command of FIGMA_CANVAS_COMMANDS) {
    assert.ok(source.includes('payload.operation === "' + command.id + '"'), command.id + " has no executor branch in code.js");
  }
});

test("wrap-in-auto-layout keeps order and infers spacing from current gaps", async () => {
  const { page, write } = createRuntime();
  const card = makeNode("FRAME", { name: "Card", width: 300, height: 300 });
  page.appendChild(card);
  const third = makeNode("TEXT", { name: "Third", x: 16, y: 120, height: 20, characters: "c" });
  const first = makeNode("TEXT", { name: "First", x: 16, y: 16, height: 20, characters: "a" });
  const second = makeNode("TEXT", { name: "Second", x: 16, y: 48, height: 20, characters: "b" });
  [third, first, second].forEach((n) => card.appendChild(n));
  const result = await write({ operation: "wrap-in-auto-layout", nodeIds: [third.id, first.id, second.id], name: "Details",
    autoLayout: { layoutMode: "VERTICAL" } });
  assert.equal(result.ok, true);
  const wrapper = card.children.find((n: MockNode) => n.name === "Details");
  assert.equal(wrapper.layoutMode, "VERTICAL");
  assert.deepEqual(JSON.parse(JSON.stringify(wrapper.children.map((n: MockNode) => n.name))), ["First", "Second", "Third"]);
  assert.equal(result.inferredItemSpacing, 12, "lower median of the 12px and 52px gaps");
  assert.equal(wrapper.x, 16);
  assert.equal(wrapper.y, 16);
  assert.equal(wrapper.fills.length, 0, "structural wrapper adds no visible surface");
  assert.equal(wrapper.clipsContent, false, "wrapping must never clip source content");
});

test("set-fills builds gradients and set-effects builds shadows and blurs", async () => {
  const { page, write } = createRuntime();
  const box = makeNode("RECTANGLE");
  page.appendChild(box);
  await write({ operation: "set-fills", nodeId: box.id, paints: [
    { type: "GRADIENT_LINEAR", angle: 90, stops: [{ position: 1, color: "#000000" }, { position: 0, color: "#FFFFFF", opacity: 0.5 }] },
  ] });
  assert.equal(box.fills[0].type, "GRADIENT_LINEAR");
  assert.equal(box.fills[0].gradientStops[0].position, 0, "stops are sorted");
  assert.equal(box.fills[0].gradientStops[0].color.a, 0.5);
  const transform = box.fills[0].gradientTransform;
  assert.ok(Math.abs(transform[0][0]) < 1e-9 && Math.abs(transform[0][1] - 1) < 1e-9, "90° maps gradient start to the top edge");
  await write({ operation: "set-fills", nodeId: box.id, paintProperty: "strokes", paints: [{ type: "SOLID", color: "#FF0000", opacity: 0.4 }] });
  assert.equal(box.strokes[0].opacity, 0.4);
  await write({ operation: "set-effects", nodeId: box.id, effects: [
    { type: "INNER_SHADOW", color: "#000000", opacity: 0.2, y: 2, blur: 6 }, { type: "BACKGROUND_BLUR", radius: 20 },
  ] });
  assert.deepEqual(box.effects.map((e: MockNode) => e.type), ["INNER_SHADOW", "BACKGROUND_BLUR"]);
  assert.equal(box.effects[0].color.a, 0.2);
});

test("INSTANCE elements and create-instance place real components with property overrides", async () => {
  const { page, write } = createRuntime();
  const button = makeNode("COMPONENT", { name: "Button", width: 120, height: 44 });
  button.instanceDefaults = { "Label#1:0": { type: "TEXT", value: "Button" }, "State": { type: "VARIANT", value: "Default" } };
  const screen = makeNode("FRAME", { name: "Screen", layoutMode: "VERTICAL" });
  page.appendChild(button); page.appendChild(screen);
  const created = await write({ operation: "create-elements", target: "node", parentNodeId: screen.id, elements: [
    { type: "INSTANCE", name: "Primary CTA", componentId: button.id, instanceProperties: { Label: "Pay ₹4,500", State: "Default" } },
  ] });
  assert.equal(created.ok, true);
  const instance = screen.children[0];
  assert.equal(instance.type, "INSTANCE");
  assert.equal(instance.width, 120, "instances keep their intrinsic size");
  assert.equal(instance.componentProperties["Label#1:0"].value, "Pay ₹4,500");

  const placed = await write({ operation: "create-instance", nodeId: button.id, parentNodeId: screen.id, index: 0,
    instanceProperties: { Label: "Cancel" } });
  assert.equal(placed.parentId, screen.id);
  assert.equal(screen.children[0].componentProperties["Label#1:0"].value, "Cancel");

  await write({ operation: "set-instance-properties", nodeId: instance.id, instanceProperties: { State: "Disabled" } });
  assert.equal(instance.componentProperties.State.value, "Disabled");
  await assert.rejects(write({ operation: "set-instance-properties", nodeId: instance.id, instanceProperties: { Missing: "x" } }), /no property Missing/);
});

test("add-component-property links a text layer and keeps its current text as the default", async () => {
  const { page, write } = createRuntime();
  const component = makeNode("COMPONENT", { name: "Chip" });
  const label = makeNode("TEXT", { characters: "Overdue" });
  page.appendChild(component); component.appendChild(label);
  const result = await write({ operation: "add-component-property", nodeId: component.id,
    componentProperty: { name: "Label", type: "TEXT", linkedNodeId: label.id } });
  assert.equal(component.componentPropertyDefinitions[result.propertyKey].defaultValue, "Overdue");
  assert.equal(label.componentPropertyReferences.characters, result.propertyKey);
});

test("set-reactions appends prototype navigation and set-flow-start marks the flow", async () => {
  const { page, write } = createRuntime();
  const home = makeNode("FRAME", { name: "Home" });
  const details = makeNode("FRAME", { name: "Details" });
  const cta = makeNode("RECTANGLE");
  page.appendChild(home); page.appendChild(details); home.appendChild(cta);
  cta.reactions = [{ trigger: { type: "ON_HOVER" }, actions: [{ type: "BACK" }] }];
  const result = await write({ operation: "set-reactions", nodeId: cta.id, reactions: [
    { trigger: "ON_CLICK", action: "NAVIGATE", destinationId: details.id, transition: { type: "SLIDE_IN", direction: "LEFT", duration: 0.3 } },
  ] });
  assert.equal(result.reactionCount, 2, "existing interactions are preserved by default");
  const action = cta.reactions[1].actions[0];
  assert.equal(action.destinationId, details.id);
  assert.equal(action.transition.direction, "LEFT");
  await write({ operation: "set-flow-start", nodeId: home.id, flowName: "Pay EMI" });
  assert.deepEqual(JSON.parse(JSON.stringify(page.flowStartingPoints)), [{ nodeId: home.id, name: "Pay EMI" }]);
});

test("create-styles upserts paint styles by name", async () => {
  const { figma, write } = createRuntime();
  const first = await write({ operation: "create-styles", styles: [{ kind: "paint", name: "Brand/Primary", paints: [{ type: "SOLID", color: "#2563EB" }] }] });
  assert.equal(first.createdCount, 1);
  const second = await write({ operation: "create-styles", styles: [{ kind: "paint", name: "Brand/Primary", paints: [{ type: "SOLID", color: "#1D4ED8" }] }] });
  assert.equal(second.updatedCount, 1);
  assert.equal(figma.__paintStyles.length, 1);
});

test("shared schema enforces required fields for extended actions", () => {
  assert.deepEqual(extendedActionIssues({ operation: "wrap-in-auto-layout", nodeIds: ["1:2"] }).map((i) => i.path), ["autoLayout"]);
  assert.deepEqual(extendedActionIssues({ operation: "set-variable-mode", nodeId: "1:2", collectionName: "Theme" }).map((i) => i.path), ["collectionName"]);
  assert.equal(extendedActionIssues({ operation: "set-fills", nodeId: "1:2", paints: [] }).length, 0);
  assert.equal(NATIVE_REACTION.safeParse({ trigger: "ON_CLICK", action: "NAVIGATE" }).success, false);
  assert.equal(NATIVE_REACTION.safeParse({ trigger: "ON_CLICK", action: "URL", url: "javascript:alert(1)" }).success, false);
});
