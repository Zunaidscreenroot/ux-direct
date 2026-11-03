/**
 * Shared Zod fields for the extended native Figma actions.
 *
 * The plugin bridge, the MCP tool schema and the AI action planner all spread
 * these shapes so a field the planner may emit is always one the bridge accepts
 * and the plugin executes. The plugin still re-validates every value natively.
 */
import { z } from "zod";

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const UNIT = z.number().finite().min(0).max(1);
const NODE_ID = z.string().trim().min(1).max(100);

const GRADIENT_STOP = z.object({
  position: UNIT,
  color: HEX,
  opacity: UNIT.optional(),
}).strict();

export const NATIVE_PAINT = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SOLID"), color: HEX, opacity: UNIT.optional(), visible: z.boolean().optional() }).strict(),
  z.object({
    type: z.enum(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]),
    stops: z.array(GRADIENT_STOP).min(2).max(8),
    angle: z.number().finite().min(-360).max(360).optional(),
    opacity: UNIT.optional(),
    visible: z.boolean().optional(),
  }).strict(),
]);

export const NATIVE_EFFECT = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["DROP_SHADOW", "INNER_SHADOW"]),
    color: HEX,
    opacity: UNIT.optional(),
    x: z.number().finite().min(-500).max(500).optional(),
    y: z.number().finite().min(-500).max(500).optional(),
    blur: z.number().finite().min(0).max(500).optional(),
    spread: z.number().finite().min(-500).max(500).optional(),
    visible: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.enum(["LAYER_BLUR", "BACKGROUND_BLUR"]),
    radius: z.number().finite().min(0).max(250),
    visible: z.boolean().optional(),
  }).strict(),
]);

export const NATIVE_LAYOUT_GRID = z.discriminatedUnion("pattern", [
  z.object({
    pattern: z.enum(["COLUMNS", "ROWS"]),
    count: z.number().int().min(1).max(48),
    alignment: z.enum(["MIN", "MAX", "CENTER", "STRETCH"]),
    gutterSize: z.number().finite().min(0).max(500),
    offset: z.number().finite().min(0).max(1000).optional(),
    sectionSize: z.number().finite().min(1).max(2000).optional(),
    color: HEX.optional(),
    opacity: UNIT.optional(),
  }).strict(),
  z.object({
    pattern: z.literal("GRID"),
    sectionSize: z.number().finite().min(1).max(1000),
    color: HEX.optional(),
    opacity: UNIT.optional(),
  }).strict(),
]);

export const NATIVE_AUTO_LAYOUT_WRAP = z.object({
  layoutMode: z.enum(["HORIZONTAL", "VERTICAL"]),
  itemSpacing: z.number().finite().min(-100).max(1000).optional(),
  padding: z.number().finite().min(0).max(1000).optional(),
  paddingLeft: z.number().finite().min(0).max(1000).optional(),
  paddingRight: z.number().finite().min(0).max(1000).optional(),
  paddingTop: z.number().finite().min(0).max(1000).optional(),
  paddingBottom: z.number().finite().min(0).max(1000).optional(),
  primaryAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional(),
  fillColor: HEX.optional(),
  cornerRadius: z.number().finite().min(0).max(512).optional(),
}).strict();

export const NATIVE_COMPONENT_PROPERTY = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]),
  defaultValue: z.union([z.string().max(500), z.boolean()]).optional(),
  linkedNodeId: NODE_ID.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === "BOOLEAN" && value.defaultValue !== undefined && typeof value.defaultValue !== "boolean") {
    ctx.addIssue({ code: "custom", path: ["defaultValue"], message: "BOOLEAN properties need a boolean defaultValue." });
  }
  if (value.type !== "BOOLEAN" && typeof value.defaultValue === "boolean") {
    ctx.addIssue({ code: "custom", path: ["defaultValue"], message: value.type + " properties need a string defaultValue." });
  }
  if ((value.type === "INSTANCE_SWAP" || value.type === "VARIANT") && typeof value.defaultValue !== "string") {
    ctx.addIssue({ code: "custom", path: ["defaultValue"], message: value.type + " requires defaultValue (a component ID for INSTANCE_SWAP, a variant value for VARIANT)." });
  }
  if (value.type === "VARIANT" && value.linkedNodeId) {
    ctx.addIssue({ code: "custom", path: ["linkedNodeId"], message: "VARIANT properties cannot be linked to a layer." });
  }
});

export const NATIVE_INSTANCE_PROPERTIES = z.record(
  z.string().trim().min(1).max(120),
  z.union([z.string().max(500), z.boolean()]),
).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 30, {
  message: "instanceProperties needs 1–30 property values.",
});

export const NATIVE_REACTION = z.object({
  trigger: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG", "AFTER_TIMEOUT", "MOUSE_ENTER", "MOUSE_LEAVE"]),
  timeout: z.number().finite().min(0).max(60).optional(),
  action: z.enum(["NAVIGATE", "OVERLAY", "SWAP", "SCROLL_TO", "BACK", "CLOSE", "URL"]),
  destinationId: NODE_ID.optional(),
  url: z.string().trim().url().max(500).optional(),
  transition: z.object({
    type: z.enum(["INSTANT", "DISSOLVE", "SMART_ANIMATE", "MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"]),
    direction: z.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]).optional(),
    duration: z.number().finite().min(0).max(10).optional(),
    easing: z.enum(["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "GENTLE", "QUICK", "BOUNCY", "SLOW"]).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (["NAVIGATE", "OVERLAY", "SWAP", "SCROLL_TO"].includes(value.action) && !value.destinationId) {
    ctx.addIssue({ code: "custom", path: ["destinationId"], message: value.action + " requires destinationId." });
  }
  if (value.action === "URL" && !value.url) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "URL action requires url." });
  }
  if (value.url && !/^https?:\/\//i.test(value.url)) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "Only http(s) prototype links are allowed." });
  }
  if (value.transition && ["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"].includes(value.transition.type) && !value.transition.direction) {
    ctx.addIssue({ code: "custom", path: ["transition", "direction"], message: "Directional transitions require direction." });
  }
});

const LINE_HEIGHT = z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(1).max(500) }).strict();
const LETTER_SPACING = z.object({ unit: z.enum(["PIXELS", "PERCENT"]), value: z.number().finite().min(-100).max(500) }).strict();

export const NATIVE_STYLE_SPEC = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paint"), name: z.string().trim().min(1).max(120), paints: z.array(NATIVE_PAINT).min(1).max(8) }).strict(),
  z.object({
    kind: z.literal("text"),
    name: z.string().trim().min(1).max(120),
    fontFamily: z.string().trim().min(1).max(100),
    fontStyle: z.string().trim().min(1).max(100),
    fontSize: z.number().finite().min(1).max(400),
    lineHeight: LINE_HEIGHT.optional(),
    letterSpacing: LETTER_SPACING.optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  }).strict(),
  z.object({ kind: z.literal("effect"), name: z.string().trim().min(1).max(120), effects: z.array(NATIVE_EFFECT).min(1).max(8) }).strict(),
]);

export const BIND_VARIABLE_PROPERTIES = [
  "fill", "stroke", "opacity", "cornerRadius", "width", "height", "itemSpacing",
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "strokeWeight", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "counterAxisSpacing", "characters", "visible",
] as const;

/** Top-level fields used by the extended actions. Spread into every action/step schema. */
export const NATIVE_ACTION_EXTENDED_FIELDS = {
  paintProperty: z.enum(["fills", "strokes"]).optional(),
  paints: z.array(NATIVE_PAINT).max(8).optional(),
  effects: z.array(NATIVE_EFFECT).max(8).optional(),
  layoutGrids: z.array(NATIVE_LAYOUT_GRID).max(6).optional(),
  autoLayout: NATIVE_AUTO_LAYOUT_WRAP.optional(),
  componentProperty: NATIVE_COMPONENT_PROPERTY.optional(),
  instanceProperties: NATIVE_INSTANCE_PROPERTIES.optional(),
  reactions: z.array(NATIVE_REACTION).min(1).max(10).optional(),
  reactionMode: z.enum(["append", "replace"]).optional(),
  flowName: z.string().trim().min(1).max(120).optional(),
  styles: z.array(NATIVE_STYLE_SPEC).min(1).max(30).optional(),
};
export const NATIVE_ACTION_EXTENDED_FIELD_KEYS = Object.keys(NATIVE_ACTION_EXTENDED_FIELDS) as Array<keyof typeof NATIVE_ACTION_EXTENDED_FIELDS>;

const RADIUS = z.number().finite().min(0).max(512);
const SIZE_LIMIT = z.number().finite().min(0).max(4096).nullable();
const STROKE_SIDE = z.number().finite().min(0).max(100);

/** Extra update-node patch fields. Spread into every patch schema. */
export const NATIVE_PATCH_EXTENDED_FIELDS = {
  strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
  dashPattern: z.array(z.number().finite().min(0).max(200)).max(8).optional(),
  strokeTopWeight: STROKE_SIDE.optional(),
  strokeRightWeight: STROKE_SIDE.optional(),
  strokeBottomWeight: STROKE_SIDE.optional(),
  strokeLeftWeight: STROKE_SIDE.optional(),
  topLeftRadius: RADIUS.optional(),
  topRightRadius: RADIUS.optional(),
  bottomLeftRadius: RADIUS.optional(),
  bottomRightRadius: RADIUS.optional(),
  cornerSmoothing: UNIT.optional(),
  minWidth: SIZE_LIMIT.optional(),
  maxWidth: SIZE_LIMIT.optional(),
  minHeight: SIZE_LIMIT.optional(),
  maxHeight: SIZE_LIMIT.optional(),
  counterAxisSpacing: z.number().finite().min(0).max(1000).optional(),
  counterAxisAlignContent: z.enum(["AUTO", "SPACE_BETWEEN"]).optional(),
  strokesIncludedInLayout: z.boolean().optional(),
  itemReverseZIndex: z.boolean().optional(),
  isMask: z.boolean().optional(),
  locked: z.boolean().optional(),
  blendMode: z.enum(["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN", "COLOR_DODGE",
    "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"]).optional(),
  paragraphSpacing: z.number().finite().min(0).max(1000).optional(),
};

/** Extra set-text-range fields. Spread into every text-range schema. */
export const NATIVE_TEXT_RANGE_EXTENDED_FIELDS = {
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
  textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  hyperlink: z.string().trim().url().max(500).nullable().optional(),
};
export const NATIVE_TEXT_RANGE_EXTENDED_KEYS = Object.keys(NATIVE_TEXT_RANGE_EXTENDED_FIELDS);

/** Fields an INSTANCE element in create-elements may carry. */
export const NATIVE_INSTANCE_ELEMENT_FIELDS = {
  componentId: NODE_ID.optional(),
  instanceProperties: NATIVE_INSTANCE_PROPERTIES.optional(),
};

type ExtendedActionInput = {
  operation: string;
  nodeId?: string;
  nodeIds?: string[];
  collectionName?: string;
  modeName?: string;
} & { [K in keyof typeof NATIVE_ACTION_EXTENDED_FIELDS]?: z.infer<(typeof NATIVE_ACTION_EXTENDED_FIELDS)[K]> };

/** Per-operation required-field rules for the extended actions. Returns human-readable issues. */
export function extendedActionIssues(value: ExtendedActionInput): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const needsNode = ["set-fills", "set-effects", "set-layout-grids", "add-component-property", "set-instance-properties",
    "set-reactions", "set-flow-start", "set-variable-mode"];
  if (needsNode.includes(value.operation) && !value.nodeId) add("nodeId", value.operation + " requires nodeId.");
  switch (value.operation) {
    case "wrap-in-auto-layout":
      if (!value.nodeIds || value.nodeIds.length < 1 || new Set(value.nodeIds).size !== value.nodeIds.length) add("nodeIds", "wrap-in-auto-layout requires unique sibling nodeIds.");
      if (!value.autoLayout) add("autoLayout", "wrap-in-auto-layout requires autoLayout.layoutMode.");
      break;
    case "set-fills":
      if (!value.paints) add("paints", "set-fills requires paints (use [] to clear).");
      break;
    case "set-effects":
      if (!value.effects) add("effects", "set-effects requires effects (use [] to clear).");
      break;
    case "set-layout-grids":
      if (!value.layoutGrids) add("layoutGrids", "set-layout-grids requires layoutGrids (use [] to clear).");
      break;
    case "add-component-property":
      if (!value.componentProperty) add("componentProperty", "add-component-property requires componentProperty.");
      break;
    case "set-instance-properties":
      if (!value.instanceProperties) add("instanceProperties", "set-instance-properties requires instanceProperties.");
      break;
    case "set-reactions":
      if (!value.reactions) add("reactions", "set-reactions requires 1–10 reactions.");
      break;
    case "set-flow-start":
      if (!value.flowName) add("flowName", "set-flow-start requires flowName.");
      break;
    case "create-styles":
      if (!value.styles) add("styles", "create-styles requires 1–30 style specs.");
      break;
    case "set-variable-mode":
      if (!value.collectionName || !value.modeName) add("collectionName", "set-variable-mode requires collectionName and modeName.");
      break;
  }
  return issues;
}

/** Every node ID referenced inside the extended fields, for planner allowlist checks. */
export function extendedActionNodeIds(value: ExtendedActionInput): string[] {
  const ids: string[] = [];
  for (const reaction of value.reactions || []) if (reaction.destinationId) ids.push(reaction.destinationId);
  if (value.componentProperty?.linkedNodeId) ids.push(value.componentProperty.linkedNodeId);
  return ids;
}

/** JSON Schema `properties` for a Zod shape, for hand-written MCP tool schemas. */
export function nativeJsonSchemaProperties(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as { properties?: Record<string, unknown> };
  const properties = schema.properties || {};
  for (const value of Object.values(properties)) {
    if (value && typeof value === "object") delete (value as Record<string, unknown>).$schema;
  }
  return properties;
}
