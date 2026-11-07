/**
 * Block-based design spec for the Figma agent.
 *
 * Free models are unreliable at authoring a full native layer tree (coordinates,
 * sizing modes, paddings, paints) in one shot. Instead the model returns a short
 * semantic spec — sections made of blocks from a fixed library plus their real
 * content — and this module deterministically expands it into the existing
 * native plan shape ({ summary, frame, elements }) that the plugin already
 * renders. Auto Layout, sizing, spacing, typography and contrast all come from
 * code here, not from the model.
 *
 * Escape hatches keep the ceiling high:
 *  - `component` places a real design-system instance from canvas.components.
 *  - `custom` accepts a raw native FRAME/TEXT/... node for anything no block covers.
 */

import { restoreSourceFidelity, sourceCtaFill, SOURCE_GRAPHIC_BUDGET } from "./source-graphics";

type Rec = Record<string, unknown>;
export type NativeNode = Rec & { type: string; name: string; width: number; height: number; children?: NativeNode[] };

export type BlockTheme = {
  background: string; surface: string; surfaceAlt: string; text: string; muted: string;
  primary: string; onPrimary: string; border: string;
  /** Fill behind onPrimary content (buttons, checks): primary, darkened just enough for a light label. */
  primaryFill: string;
  success: string; warning: string; danger: string; info: string;
  radius: number; dark: boolean;
};

export type BlockExpansion = {
  plan: { summary: string; frame: Rec; elements: NativeNode[]; learningCandidate?: unknown } | null;
  /** Non-fatal adjustments (unknown blocks dropped, depth flattened, contrast fixed...). */
  warnings: string[];
  /** Fatal problems to send back to the model as validation feedback. */
  errors: string[];
  nodeCount: number;
  blockCount: number;
};

/** Layers the model's blocks may expand to; source graphic clones get the rest of PLAN_NODE_LIMIT. */
export const BLOCK_NODE_BUDGET = 105;
/** normalizePlan, the plan schema and the plugin all accept at most this many nodes (depth 0–4). */
export const PLAN_NODE_LIMIT = 140;
const MAX_DEPTH = 4;
const FONT = "Inter";

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function hex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return ("#" + v.slice(1).split("").map((c) => c + c).join("")).toUpperCase();
  return null;
}

function rgb(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function mix(a: string, b: string, amountOfB: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  return toHex([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * amountOfB) as [number, number, number]);
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Nudge fg toward black or white until it reaches the ratio against bg (matches the 4.5:1 preflight). */
export function ensureContrast(fg: string, bg: string, min = 4.6): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = contrast("#000000", bg) >= contrast("#FFFFFF", bg) ? "#000000" : "#FFFFFF";
  for (let step = 1; step <= 10; step += 1) {
    const next = mix(fg, target, step / 10);
    if (contrast(next, bg) >= min) return next;
  }
  return target;
}

const LIGHT: Omit<BlockTheme, "background" | "dark" | "primaryFill"> = {
  surface: "#FFFFFF", surfaceAlt: "#F1F3F6", text: "#111827", muted: "#5B6472",
  primary: "#1F5EFF", onPrimary: "#FFFFFF", border: "#E2E6EC",
  success: "#137333", warning: "#9A5800", danger: "#C5221F", info: "#1F5EFF", radius: 12,
};
const DARK: Omit<BlockTheme, "background" | "dark" | "primaryFill"> = {
  surface: "#1C1F24", surfaceAlt: "#262A31", text: "#F5F7FA", muted: "#A8B0BC",
  primary: "#6EA8FF", onPrimary: "#0B1220", border: "#343A44",
  success: "#5BD08A", warning: "#F2B84B", danger: "#FF7A70", info: "#6EA8FF", radius: 12,
};

/**
 * Keep a light (source-style) label on primary buttons: darken the button fill up to 30% until the
 * label reaches 4.6:1. Only when that would change the colour too much fall back to a dark label.
 */
function primaryPair(primary: string, requested: string | null, fallback: string): { primaryFill: string; onPrimary: string } {
  const light = requested && luminance(requested) > 0.5 ? requested : requested ? null : "#FFFFFF";
  if (light) {
    for (let step = 0; step <= 6; step += 1) {
      const fill = step ? mix(primary, "#000000", step * 0.05) : primary;
      if (contrast(light, fill) >= 4.6) return { primaryFill: fill, onPrimary: light };
    }
  }
  return { primaryFill: primary, onPrimary: ensureContrast(requested && !light ? requested : fallback, primary) };
}

export function resolveTheme(raw: unknown, sourceBackground: string | null, sourcePrimary: string | null = null): BlockTheme {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Rec : {};
  const background = hex(input.background) || hex(input.backgroundColor) || sourceBackground || "#F7F8FA";
  const dark = luminance(background) < 0.25;
  const base = dark ? DARK : LIGHT;
  const pick = (key: keyof typeof base) => (typeof base[key] === "string" ? (hex(input[key]) || base[key]) : base[key]) as string;
  const surface = pick("surface");
  // The source's own filled CTA colour beats both the model's guess and the dark default
  // (#6EA8FF with dark text read as a pale lavender "Pay now" on dark screens).
  const primary = sourcePrimary || pick("primary");
  const radiusInput = typeof input.radius === "number" && Number.isFinite(input.radius) ? input.radius : base.radius;
  const text = ensureContrast(pick("text"), surface, 7);
  const theme: BlockTheme = {
    background, dark, surface,
    surfaceAlt: pick("surfaceAlt"),
    text,
    muted: ensureContrast(pick("muted"), surface),
    primary,
    ...primaryPair(primary, hex(input.onPrimary), pick("onPrimary")),
    border: pick("border"),
    success: pick("success"), warning: pick("warning"), danger: pick("danger"), info: pick("info"),
    radius: Math.max(0, Math.min(28, Math.round(radiusInput))),
  };
  return theme;
}

// ---------------------------------------------------------------------------
// Source design-system tokens
// ---------------------------------------------------------------------------

type SourceText = { size: number; weight: string; color: string | null; textStyleId: string | null };
type SourceHeader = { componentId: string; name: string; height: number; instanceProperties?: Record<string, string | boolean>; textOverrides?: Record<string, string> };
/** What the selected source screen already uses: its type scale, text styles and header component. */
export type SourceTokens = { sizes: number[]; texts: SourceText[]; header: SourceHeader | null };

function isBoldWeight(weight: string): boolean {
  return /semi|bold|black|heavy|extra/i.test(weight);
}

export function collectSourceTokens(canvas: Record<string, unknown>, componentIds: Set<string>): SourceTokens {
  const texts: SourceText[] = [];
  const seen = new Set<string>();
  const root = asRec(arr(canvas.nodes)[0]);
  const walk = (node: Rec, insideInstance: boolean, depth: number) => {
    if (depth > 12 || texts.length >= 60) return;
    // Text inside instances belongs to the component, not the screen's own type scale.
    if (node.type === "TEXT" && !insideInstance && typeof node.fontSize === "number" && Number.isFinite(node.fontSize)) {
      const weight = clean(node.fontStyle, 40) || "Regular";
      const color = Array.isArray(node.fillColors) ? hex(node.fillColors[0]) : null;
      const textStyleId = typeof node.textStyleId === "string" && node.textStyleId ? node.textStyleId : null;
      const key = [node.fontSize, weight, color, textStyleId].join("|");
      if (!seen.has(key)) { seen.add(key); texts.push({ size: Math.round(node.fontSize), weight, color, textStyleId }); }
    }
    for (const child of arr(node.children)) {
      const rec = asRec(child);
      if (rec) walk(rec, insideInstance || node.type === "INSTANCE", depth + 1);
    }
  };
  if (root) walk(root, false, 0);

  let header: SourceHeader | null = null;
  const first = root ? asRec(arr(root.children)[0]) : null;
  const rootWidth = root && typeof root.width === "number" ? root.width : 0;
  if (first && first.type === "INSTANCE" && typeof first.mainComponentId === "string" && componentIds.has(first.mainComponentId) &&
      typeof first.width === "number" && rootWidth > 0 && first.width >= rootWidth * 0.9 &&
      (typeof first.y !== "number" || first.y <= 8) && typeof first.height === "number" && first.height <= 140) {
    const props = asRec(first.componentProperties);
    const instanceProperties = props ? Object.fromEntries(Object.entries(props)
      .filter((e): e is [string, string | boolean] => typeof e[1] === "string" || typeof e[1] === "boolean").slice(0, 20)) : {};
    const textOverrides: Record<string, string> = {};
    const collect = (node: Rec, depth: number) => {
      if (depth > 6) return;
      if (node.type === "TEXT" && typeof node.name === "string" && typeof node.text === "string" && node.text.trim()) textOverrides[node.name.slice(0, 120)] = node.text.slice(0, 500);
      for (const child of arr(node.children)) { const rec = asRec(child); if (rec) collect(rec, depth + 1); }
    };
    collect(first, 0);
    header = { componentId: first.mainComponentId, name: clean(first.name, 80) || "Screen header", height: Math.max(24, Math.round(first.height)),
      ...(Object.keys(instanceProperties).length ? { instanceProperties } : {}),
      ...(Object.keys(textOverrides).length ? { textOverrides } : {}) };
  }
  return { sizes: [...new Set(texts.map((t) => t.size))].sort((a, b) => a - b), texts, header };
}

// ---------------------------------------------------------------------------
// Native node builders
// ---------------------------------------------------------------------------

type TextOpts = { size?: number; weight?: "Regular" | "Medium" | "Semi Bold" | "Bold"; color: string; bg: string; align?: "LEFT" | "CENTER" | "RIGHT"; hug?: boolean };

const CHAR_WIDTH = 0.56;

function textWidth(text: string, size: number): number {
  const longest = text.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0);
  return Math.ceil(longest * size * CHAR_WIDTH) + 2;
}

function textHeight(text: string, size: number, width: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * CHAR_WIDTH)));
  const lines = text.split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.ceil(lines * size * 1.4);
}

function clean(value: unknown, max = 400): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.replace(/\s+\n/g, "\n").trim().slice(0, max) : "";
}

function label(value: string, fallback: string): string {
  const base = value.replace(/\s+/g, " ").trim().slice(0, 48);
  return base ? fallback + " · " + base : fallback;
}

/** Spacing on the 4px grid (2→4, 6→8, 10→12, 14→16), so hygiene checks see a consistent scale. */
function grid4(value: number): number {
  return value <= 0 ? 0 : Math.max(4, Math.round(value / 4) * 4);
}

class Builder {
  count = 0;
  warnings: string[] = [];
  /** The reused source header instance, so expandBlockSpec can place it full-bleed. */
  headerNode: NativeNode | null = null;
  constructor(readonly theme: BlockTheme, readonly source: SourceTokens | null = null) {}

  /**
   * Snap a requested size to the source type scale (within 2px) and adopt the matching source
   * text's weight, colour and text style, so variations reuse the screen's typography.
   */
  private sourceType(name: string, size: number, weight: string, color: string) {
    const src = this.source;
    if (!src || !src.texts.length) return { size, weight, color, textStyleId: null as string | null };
    const nearest = src.sizes.reduce((best, s) => Math.abs(s - size) < Math.abs(best - size) ? s : best, src.sizes[0]);
    const snapped = Math.abs(nearest - size) <= 2 ? nearest : size;
    const same = src.texts.filter((t) => t.size === snapped);
    const bold = isBoldWeight(weight);
    const exact = (styled: boolean) => same.find((t) => t.weight === weight && (!styled || !!t.textStyleId));
    const sameClass = (styled: boolean) => same.find((t) => isBoldWeight(t.weight) === bold && (!styled || !!t.textStyleId));
    const titleLike = /title|heading/i.test(name);
    const match = titleLike
      ? exact(true) ?? sameClass(true) ?? exact(false) ?? sameClass(false)
      : exact(true) ?? exact(false) ?? sameClass(true) ?? sameClass(false);
    if (!match) return { size: snapped, weight, color, textStyleId: null };
    const neutral = color === this.theme.text || color === this.theme.muted;
    return { size: snapped, weight: match.weight, color: neutral && match.color ? match.color : color, textStyleId: match.textStyleId };
  }

  text(name: string, value: string, width: number, opts: TextOpts): NativeNode {
    this.count += 1;
    const type = this.sourceType(name, opts.size ?? 14, opts.weight ?? "Regular", opts.color);
    let size = type.size;
    // One unbreakable token (an amount, a loan ID) never wraps mid-word: shrink it to fit, to 11px.
    const token = !/\s/.test(value.trim());
    while (token && size > 11 && textWidth(value, size) > width) size -= 1;
    const natural = textWidth(value, size);
    const hug = (opts.hug === true || token) && natural <= width;
    const w = hug ? natural : Math.max(1, Math.floor(width));
    return {
      type: "TEXT", name: label(value, name), x: 0, y: 0, width: w, height: textHeight(value, size, w),
      text: value, fontSize: size, fontFamily: FONT, fontStyle: type.weight,
      color: ensureContrast(type.color, opts.bg),
      ...(type.textStyleId && size === type.size ? { textStyleId: type.textStyleId } : {}),
      textAlignHorizontal: opts.align ?? "LEFT",
      textAutoResize: hug ? "WIDTH_AND_HEIGHT" : "HEIGHT",
      layoutSizingHorizontal: hug ? "HUG" : "FILL",
      layoutSizingVertical: "HUG",
    };
  }

  rect(name: string, width: number, height: number, color: string, extra: Rec = {}): NativeNode {
    this.count += 1;
    return { type: "RECTANGLE", name, x: 0, y: 0, width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)), color, ...extra };
  }

  /** Vertical Auto Layout frame that hugs its content height and fills the parent width. */
  vstack(name: string, width: number, children: NativeNode[], opts: { gap?: number; pad?: [number, number, number, number]; fill?: string | null; radius?: number; stroke?: string; align?: "MIN" | "CENTER" | "MAX"; hugWidth?: boolean } = {}): NativeNode {
    this.count += 1;
    const [pt, pr, pb, pl] = (opts.pad ?? [0, 0, 0, 0]).map(grid4);
    const gap = grid4(opts.gap ?? 8);
    const flow = children.filter((child) => child.layoutPositioning !== "ABSOLUTE");
    const height = pt + pb + flow.reduce((sum, child) => sum + child.height, 0) + Math.max(0, flow.length - 1) * gap;
    const hugWidth = opts.hugWidth === true;
    const w = hugWidth ? pl + pr + flow.reduce((max, child) => Math.max(max, child.width), 0) : Math.max(1, Math.floor(width));
    const node: NativeNode = {
      type: "FRAME", name, x: 0, y: 0, width: w, height: Math.max(1, Math.ceil(height)),
      layoutMode: "VERTICAL", itemSpacing: gap,
      paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl,
      primaryAxisSizingMode: "AUTO", counterAxisSizingMode: hugWidth ? "AUTO" : "FIXED",
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: opts.align ?? "MIN",
      layoutSizingHorizontal: hugWidth ? "HUG" : "FILL", layoutSizingVertical: "HUG",
      children,
    };
    this.paint(node, opts.fill ?? null, opts.radius, opts.stroke);
    return node;
  }

  /** Horizontal Auto Layout frame: fills parent width, hugs the tallest child. */
  hstack(name: string, width: number, children: NativeNode[], opts: { gap?: number; pad?: [number, number, number, number]; fill?: string | null; radius?: number; stroke?: string; justify?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"; align?: "MIN" | "CENTER" | "MAX"; hugWidth?: boolean; fixedHeight?: number; wrap?: boolean } = {}): NativeNode {
    this.count += 1;
    const [pt, pr, pb, pl] = (opts.pad ?? [0, 0, 0, 0]).map(grid4);
    const gap = grid4(opts.gap ?? 8);
    const flow = children.filter((child) => child.layoutPositioning !== "ABSOLUTE");
    const tallest = flow.reduce((max, child) => Math.max(max, child.height), 0);
    const hugWidth = opts.hugWidth === true;
    const naturalWidth = pl + pr + flow.reduce((sum, child) => sum + child.width, 0) + Math.max(0, flow.length - 1) * gap;
    const w = hugWidth ? naturalWidth : Math.max(1, Math.floor(width));
    let height = pt + pb + tallest;
    if (opts.wrap && !hugWidth) {
      // Estimate wrapped rows so the parent's height budget stays honest.
      let rows = 1;
      let line = pl;
      for (const child of flow) {
        if (line > pl && line + child.width > w - pr) { rows += 1; line = pl; }
        line += child.width + gap;
      }
      height = pt + pb + rows * tallest + (rows - 1) * gap;
    }
    const fixed = typeof opts.fixedHeight === "number";
    const node: NativeNode = {
      type: "FRAME", name, x: 0, y: 0, width: w, height: Math.max(1, Math.ceil(fixed ? Math.max(opts.fixedHeight!, height) : height)),
      layoutMode: "HORIZONTAL", itemSpacing: gap,
      paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl,
      primaryAxisSizingMode: hugWidth ? "AUTO" : "FIXED", counterAxisSizingMode: fixed ? "FIXED" : "AUTO",
      primaryAxisAlignItems: opts.justify ?? "MIN", counterAxisAlignItems: opts.align ?? "CENTER",
      layoutSizingHorizontal: hugWidth ? "HUG" : "FILL", layoutSizingVertical: fixed ? "FIXED" : "HUG",
      ...(opts.wrap ? { layoutWrap: "WRAP" } : {}),
      children,
    };
    this.paint(node, opts.fill ?? null, opts.radius, opts.stroke);
    return node;
  }

  /** Free-positioned frame (for rings and other layered indicators). */
  canvas(name: string, width: number, height: number, children: NativeNode[]): NativeNode {
    this.count += 1;
    return { type: "FRAME", name, x: 0, y: 0, width, height, layoutMode: "NONE", noFill: true, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", children };
  }

  private paint(node: NativeNode, fill: string | null, radius?: number, stroke?: string) {
    if (fill) node.color = fill; else node.noFill = true;
    if (typeof radius === "number" && radius > 0) node.cornerRadius = radius;
    if (stroke) { node.strokeColor = stroke; node.strokeWeight = 1; }
  }
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const TYPE_ALIASES: Record<string, string> = {
  appbar: "app_bar", app_bar: "app_bar", header: "app_bar", top_bar: "app_bar", navbar: "app_bar", nav_bar: "app_bar", toolbar: "app_bar",
  heading: "heading", title: "heading", section_title: "heading", section_header: "heading",
  text: "text", paragraph: "text", body: "text", caption: "text", note: "text", label: "text", disclaimer: "text",
  stat: "stat", metric: "stat", amount: "stat", kpi: "stat", hero_value: "stat",
  stat_row: "stat_row", stats: "stat_row", metrics: "stat_row", metric_row: "stat_row",
  row: "row", list_row: "row", list_item: "row", item: "row", key_value: "row", kv: "row", detail_row: "row", info_row: "row", menu_item: "row", transaction: "row",
  list: "list", rows: "list", key_values: "list", details: "list",
  badge: "badge", status: "badge", tag: "badge", pill: "badge",
  progress_ring: "progress_ring", ring: "progress_ring", donut: "progress_ring", circular_progress: "progress_ring",
  progress_bar: "progress_bar", progress: "progress_bar", bar: "progress_bar", stepper_bar: "progress_bar",
  button: "button", cta: "button", action: "button",
  buttons: "buttons", button_row: "buttons", actions: "buttons", cta_group: "buttons",
  input: "input", field: "input", text_field: "input", form_field: "input", textfield: "input", dropdown: "input", select: "input",
  tabs: "tabs", segmented: "tabs", segmented_control: "tabs", tab_bar: "tabs",
  chips: "chips", filters: "chips", chip_group: "chips",
  banner: "banner", alert: "banner", callout: "banner", notice: "banner", info_box: "banner",
  divider: "divider", separator: "divider", line: "divider",
  checkbox: "checkbox", consent: "checkbox", toggle: "checkbox", switch: "checkbox", radio: "checkbox",
  bottom_nav: "bottom_nav", bottom_bar: "bottom_nav", tab_navigation: "bottom_nav",
  skeleton: "skeleton", shimmer: "skeleton", skeleton_lines: "skeleton", loading_placeholder: "skeleton",
  image: "image", illustration: "image", placeholder: "image", media: "image", hero_image: "image",
  otp: "otp", pin: "otp", code_input: "otp",
  steps: "steps", stepper: "steps", timeline: "steps",
  card: "card", group: "card", panel: "card", tile: "card",
  component: "component", instance: "component",
  custom: "custom", raw: "custom", native: "custom",
};

function blockType(block: Rec): string {
  const raw = clean(block.type ?? block.block ?? block.kind ?? block.component_type, 40).toLowerCase().replace(/[\s-]+/g, "_");
  return TYPE_ALIASES[raw] ?? "";
}

/** Free models often invent block names; infer the closest block from the fields they filled in. */
function inferBlockType(block: Rec): string {
  const has = (key: string) => clean(block[key], 400) !== "";
  if (Array.isArray(block.items) || Array.isArray(block.rows)) return "list";
  if (Array.isArray(block.blocks) || Array.isArray(block.children)) return "card";
  if ((has("label") || has("title") || has("name")) && (has("value") || has("amount"))) return "row";
  if (has("label") && (block.action !== undefined || has("variant") || has("onPress") || has("onClick"))) return "button";
  if (has("text") || has("content") || has("body") || has("label") || has("value") || has("description")) return "text";
  if (has("title") || has("heading")) return "heading";
  return "";
}

/** Blocks may arrive as plain strings or under other keys; normalize them to block records. */
/**
 * More than 8 sections used to reject the whole spec (the top model-side failure). Instead the
 * smallest neighbouring pair is merged into one plain section, a card section becoming a card
 * block inside it, until 8 remain. Content and order are kept.
 */
function mergeExtraSections(sections: Rec[]): Rec[] {
  const out = [...sections];
  const asBlocks = (section: Rec): Rec[] => {
    const surface = clean(section.surface ?? section.style, 20).toLowerCase();
    const blocks = sectionBlocks(section);
    if (surface === "card") return [{ type: "card", title: section.title, name: section.name, blocks }];
    const title = clean(section.title, 160);
    return title && title !== clean(section.name, 160) ? [{ type: "heading", title }, ...blocks] : blocks;
  };
  while (out.length > 8) {
    let best = 1;
    for (let i = 1; i < out.length; i += 1) {
      if (sectionBlocks(out[i - 1]).length + sectionBlocks(out[i]).length < sectionBlocks(out[best - 1]).length + sectionBlocks(out[best]).length) best = i;
    }
    const a = out[best - 1], b = out[best];
    out.splice(best - 1, 2, { name: clean(a.name ?? a.title, 80) || "Section", blocks: [...asBlocks(a), ...asBlocks(b)] });
  }
  return out;
}

const rowLeading = (block: Rec) => clean(block.icon ?? block.leading ?? block.avatar, 3);

/**
 * Repeated rows share one leading slot: when some rows of a group have a leading icon and others
 * don't, the others get an empty 36px spacer so every label starts on the same x (create-mode
 * retest: EMI/Paid had a check icon, Due/Outstanding sat flush-left).
 */
export function alignRowLeading(blocks: Rec[]): Rec[] {
  const rows = blocks.filter((block) => blockType(block) === "row");
  if (rows.length < 2 || !rows.some(rowLeading) || rows.every(rowLeading)) return blocks;
  return blocks.map((block) => blockType(block) === "row" && !rowLeading(block) ? { ...block, leadingSpacer: true } : block);
}

function sectionBlocks(section: Rec): Rec[] {
  const raw = section.blocks ?? section.children ?? section.items ?? section.content ?? section.rows ?? section.elements;
  if (Array.isArray(raw)) {
    return alignRowLeading(raw.map((item) => typeof item === "string" ? { type: "text", text: item } : asRec(item)).filter((x): x is Rec => !!x));
  }
  // A "section" that is really a single block.
  return blockType(section) && blockType(section) !== "card" ? [section] : [];
}

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function tone(value: unknown): "success" | "warning" | "danger" | "info" | "neutral" {
  const v = clean(value, 20).toLowerCase();
  if (/^(success|positive|ok|paid|done|complete|completed|green|active|verified)$/.test(v)) return "success";
  if (/^(warning|warn|pending|due|caution|amber|orange|yellow)$/.test(v)) return "warning";
  if (/^(danger|error|negative|overdue|failed|red|critical|rejected)$/.test(v)) return "danger";
  if (/^(info|primary|blue|brand|highlight)$/.test(v)) return "info";
  return "neutral";
}

function percent(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseFloat(clean(value, 20));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n <= 1 && String(value).indexOf("%") < 0 && n > 0 && !Number.isInteger(n) ? n * 100 : n));
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

type Ctx = { b: Builder; t: BlockTheme; bg: string; componentIds: Set<string>; skeleton?: boolean };

function toneColor(t: BlockTheme, kind: ReturnType<typeof tone>): string {
  return kind === "neutral" ? t.muted : t[kind];
}

/** Text-free placeholder shapes in the screen's own theme: lines, one block, or a circle (empty-state art). */
function skeletonNode(ctx: Ctx, block: Rec, W: number): NativeNode {
  const { b, t } = ctx;
  // A shade between the surface and the text colour reads as a skeleton on light and dark screens.
  const shade = mix(t.surface === t.background ? t.surfaceAlt : t.surface, t.text, 0.14);
  const height = typeof block.height === "number" ? Math.max(8, Math.min(320, block.height)) : 0;
  if (clean(block.shape, 20).toLowerCase() === "circle") {
    const size = Math.max(40, Math.min(160, height || 96));
    const circle: NativeNode = { type: "ELLIPSE", name: "Skeleton circle", x: 0, y: 0, width: size, height: size, color: mix(t.background, t.primary, 0.18) };
    b.count += 1;
    return b.hstack("Skeleton art", W, [circle], { justify: "CENTER", align: "CENTER" });
  }
  if (height >= 40) return b.rect("Skeleton block", W, height, shade, { cornerRadius: 8, layoutSizingHorizontal: "FILL" });
  const lines = Math.max(1, Math.min(6, typeof block.lines === "number" ? Math.round(block.lines) : 3));
  const lineHeight = height || 12;
  const bars = Array.from({ length: lines }, (_, i) => b.rect("Skeleton line", Math.round(W * (i === 0 ? 0.6 : i === lines - 1 ? 0.45 : 0.85)), lineHeight, shade, { cornerRadius: Math.min(6, lineHeight / 2) }));
  return b.vstack("Skeleton", W, bars, { gap: 8 });
}

function badgeNode(ctx: Ctx, textValue: string, kind: ReturnType<typeof tone>): NativeNode {
  const { b, t } = ctx;
  const color = toneColor(t, kind);
  const fill = mix(t.surface, color, t.dark ? 0.22 : 0.12);
  const txt = b.text("Badge label", textValue, 400, { size: 12, weight: "Medium", color, bg: fill, hug: true });
  return b.hstack(label(textValue, "Status badge"), 0, [txt], { pad: [4, 10, 4, 10], fill, radius: 100, hugWidth: true });
}

function expandLeaf(ctx: Ctx, block: Rec, type: string, width: number, depth: number): NativeNode | null {
  const { b, t, bg } = ctx;
  const W = Math.max(40, Math.floor(width));
  switch (type) {
    case "app_bar": {
      // The source screen's own header component wins over a hand-drawn app bar.
      const header = b.source?.header;
      if (header && !b.headerNode && depth <= 1) {
        b.count += 1;
        const node: NativeNode = { type: "INSTANCE", name: header.name, componentId: header.componentId, x: 0, y: 0, width: W, height: header.height,
          layoutSizingHorizontal: "FILL",
          ...(header.instanceProperties ? { instanceProperties: { ...header.instanceProperties } } : {}),
          ...(header.textOverrides ? { textOverrides: { ...header.textOverrides } } : {}) };
        b.headerNode = node;
        return node;
      }
      const title = clean(block.title ?? block.text, 120);
      if (!title) return null;
      const left: NativeNode[] = [];
      if (block.back !== false && (block.back === true || block.back === undefined && depth <= 1)) {
        left.push(b.text("Back", "←", 40, { size: 20, color: t.text, bg, hug: true }));
      }
      const actionText = clean(block.action, 30);
      const actionNode = actionText ? b.text("Header action", actionText, W / 3, { size: 14, weight: "Medium", color: t.primary, bg, hug: true }) : null;
      const used = left.reduce((s, n) => s + n.width + 12, 0) + (actionNode ? actionNode.width + 12 : 0);
      const subtitle = clean(block.subtitle, 160);
      const titleNodes = [b.text("Screen title", title, W - used, { size: 20, weight: "Semi Bold", color: t.text, bg })];
      if (subtitle) titleNodes.push(b.text("Screen subtitle", subtitle, W - used, { size: 13, color: t.muted, bg }));
      const titleStack = titleNodes.length > 1 ? b.vstack("Title", W - used, titleNodes, { gap: 2 }) : titleNodes[0];
      return b.hstack(label(title, "App bar"), W, [...left, titleStack, ...(actionNode ? [actionNode] : [])], { gap: 12, pad: [8, 0, 8, 0] });
    }
    case "heading": {
      const title = clean(block.title ?? block.text, 160);
      if (!title) return null;
      const subtitle = clean(block.subtitle ?? block.caption, 300);
      const titleNode = b.text("Heading", title, W, { size: clean(block.level, 4) === "1" ? 22 : 17, weight: "Semi Bold", color: t.text, bg });
      if (!subtitle) return titleNode;
      return b.vstack(label(title, "Heading"), W, [titleNode, b.text("Heading support", subtitle, W, { size: 13, color: t.muted, bg })], { gap: 4 });
    }
    case "text": {
      const value = clean(block.text ?? block.value ?? block.content ?? block.body ?? block.label ?? block.description ?? block.title, 1200);
      if (!value) return null;
      const kind = clean(block.tone ?? block.style ?? block.variant, 20).toLowerCase();
      const muted = /muted|caption|secondary|note|disclaimer|helper/.test(kind) || /caption|disclaimer|note/.test(clean(block.type, 30).toLowerCase());
      const small = /caption|note|disclaimer|small|legal/.test(kind + " " + clean(block.type, 30).toLowerCase());
      return b.text("Text", value, W, { size: small ? 12 : 14, color: muted ? t.muted : t.text, bg, weight: /strong|bold|emphasis/.test(kind) ? "Semi Bold" : "Regular" });
    }
    case "stat": {
      const value = clean(block.value ?? block.amount ?? block.text, 60);
      if (!value) return null;
      const lbl = clean(block.label ?? block.title, 120);
      const caption = clean(block.caption ?? block.subtitle ?? block.helper, 200);
      const kids: NativeNode[] = [];
      if (lbl) kids.push(b.text("Stat label", lbl, W, { size: 13, color: t.muted, bg }));
      kids.push(b.text("Stat value", value, W, { size: block.size === "small" ? 20 : 28, weight: "Semi Bold", color: tone(block.tone) === "neutral" ? t.text : toneColor(t, tone(block.tone)), bg }));
      if (caption) kids.push(b.text("Stat caption", caption, W, { size: 12, color: t.muted, bg }));
      return kids.length === 1 ? kids[0] : b.vstack(label(lbl || value, "Stat"), W, kids, { gap: 4 });
    }
    case "stat_row": {
      const items = arr(block.items ?? block.stats ?? block.metrics).map(asRec).filter((x): x is Rec => !!x).slice(0, 4);
      if (!items.length) return null;
      const gap = 12;
      const cell = Math.floor((W - gap * (items.length - 1)) / items.length);
      // Amounts and IDs must not wrap ("₹12, / 000"; finding 59): shrink the value type to fit the
      // cell, and when even 13px is too wide, show the stats as label/value rows instead.
      const values = items.map((item) => clean(item.value ?? item.amount, 40));
      const valueSize = [17, 15, 13].find((size) => values.every((v) => !v || textWidth(v, size) <= cell));
      if (!valueSize) {
        const rows = items.map((item) => expandLeaf(ctx, { type: "row", label: clean(item.label ?? item.title, 80) || clean(item.value ?? item.amount, 40),
          value: clean(item.label ?? item.title, 80) ? item.value ?? item.amount : undefined, caption: item.caption }, "row", W, depth)).filter((n): n is NativeNode => !!n);
        return rows.length === 1 ? rows[0] : b.vstack("Stats", W, rows, { gap: 0 });
      }
      const cells = items.map((item) => {
        const lbl = clean(item.label ?? item.title, 80);
        const value = clean(item.value ?? item.amount, 40);
        const kids: NativeNode[] = [];
        if (lbl) kids.push(b.text("Stat label", lbl, cell, { size: 12, color: t.muted, bg }));
        if (value) kids.push(b.text("Stat value", value, cell, { size: valueSize, weight: "Semi Bold", color: t.text, bg }));
        const cap = clean(item.caption, 80);
        if (cap) kids.push(b.text("Stat caption", cap, cell, { size: 11, color: t.muted, bg }));
        const stack = b.vstack(label(lbl || value, "Stat"), cell, kids, { gap: 2 });
        stack.layoutSizingHorizontal = "FILL";
        stack.layoutGrow = 1;
        return stack;
      });
      return b.hstack("Stats row", W, cells, { gap, align: "MIN" });
    }
    case "row": {
      const lbl = clean(block.label ?? block.title ?? block.name ?? block.text, 160);
      if (!lbl) return null;
      const value = clean(block.value ?? block.amount ?? block.detail ?? block.right, 80);
      const caption = clean(block.caption ?? block.subtitle ?? block.description ?? block.meta, 200);
      const status = clean(block.status ?? block.badge, 30);
      const leadingText = clean(block.icon ?? block.leading ?? block.avatar, 3);
      const right: NativeNode[] = [];
      if (value) right.push(b.text("Row value", value, W * 0.5, { size: 14, weight: "Semi Bold", color: tone(block.tone) === "neutral" ? t.text : toneColor(t, tone(block.tone)), bg, hug: true, align: "RIGHT" }));
      if (status) right.push(badgeNode(ctx, status, tone(block.statusTone ?? block.status_tone ?? block.tone ?? status)));
      if (block.chevron === true || block.chevron === undefined && block.action === true) right.push(b.text("Chevron", "›", 20, { size: 20, color: t.muted, bg, hug: true }));
      const leading = leadingText ? (() => {
        const fill = mix(t.surface, t.primary, t.dark ? 0.25 : 0.12);
        const glyph = b.text("Leading icon", leadingText, 40, { size: 14, weight: "Semi Bold", color: t.primary, bg: fill, hug: true, align: "CENTER" });
        return b.hstack("Leading", 0, [glyph], { fill, radius: 100, justify: "CENTER", align: "CENTER", pad: [0, 0, 0, 0], hugWidth: false, fixedHeight: 36 });
      })() : null;
      if (leading) { leading.width = 36; leading.layoutSizingHorizontal = "FIXED"; leading.primaryAxisSizingMode = "FIXED"; }
      const spacer = !leading && block.leadingSpacer === true
        ? (() => { const node = b.hstack("Leading spacer", 0, [], { pad: [0, 0, 0, 0], hugWidth: false, fixedHeight: 36 });
          node.width = 36; node.layoutSizingHorizontal = "FIXED"; node.primaryAxisSizingMode = "FIXED"; return node; })()
        : null;
      const slot = leading ?? spacer;
      const gap = 12;
      const rightWidth = right.reduce((s, n) => s + n.width, 0) + Math.max(0, right.length - 1) * gap;
      // A long value would crush the label: stack vertically instead of colliding.
      if (rightWidth > W * 0.55) {
        const kids: NativeNode[] = [b.text("Row label", lbl, W, { size: 14, color: t.text, bg })];
        if (caption) kids.push(b.text("Row caption", caption, W, { size: 12, color: t.muted, bg }));
        if (value) kids.push(b.text("Row value", value, W, { size: 14, weight: "Semi Bold", color: t.text, bg }));
        if (status) kids.push(badgeNode(ctx, status, tone(block.statusTone ?? block.tone ?? status)));
        return b.vstack(label(lbl, "Row"), W, kids, { gap: 4, pad: [8, 0, 8, 0] });
      }
      const leftWidth = Math.max(40, W - rightWidth - (right.length ? gap : 0) - (slot ? 36 + gap : 0));
      const labelNode = b.text("Row label", lbl, leftWidth, { size: 14, color: t.text, bg });
      let left: NativeNode = labelNode;
      if (caption) left = b.vstack(label(lbl, "Row text"), leftWidth, [labelNode, b.text("Row caption", caption, leftWidth, { size: 12, color: t.muted, bg })], { gap: 2 });
      left.layoutSizingHorizontal = "FILL";
      left.layoutGrow = 1;
      // Trailing items sit directly in the row (no wrapper) to keep the tree shallow.
      return b.hstack(label(lbl, "Row"), W, [...(slot ? [slot] : []), left, ...right], { gap, pad: [10, 0, 10, 0], justify: "SPACE_BETWEEN" });
    }
    case "badge": {
      const value = clean(block.text ?? block.label ?? block.value, 40);
      return value ? badgeNode(ctx, value, tone(block.tone ?? value)) : null;
    }
    case "progress_ring": {
      const pct = percent(block.percent ?? block.value ?? block.progress);
      const size = 72;
      const track = { type: "ELLIPSE", name: "Progress track", x: 0, y: 0, width: size, height: size, color: t.border,
        arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0.78 } } as NativeNode;
      const start = -Math.PI / 2;
      const arc = { type: "ELLIPSE", name: "Progress " + Math.round(pct) + "%", x: 0, y: 0, width: size, height: size, color: toneColor(t, tone(block.tone)) === t.muted ? t.primary : toneColor(t, tone(block.tone)),
        arcData: { startingAngle: start, endingAngle: start + Math.max(0.02, (pct / 100) * Math.PI * 2), innerRadius: 0.78 } } as NativeNode;
      b.count += 2;
      const centerText = clean(block.center ?? block.centerText, 12) || Math.round(pct) + "%";
      const pctNode = b.text("Progress value", centerText, size, { size: 15, weight: "Semi Bold", color: t.text, bg, align: "CENTER" });
      // The ring is an absolute canvas: a hugging token ("80%") would sit at x=0 over the stroke.
      pctNode.width = size;
      pctNode.x = 0;
      pctNode.textAutoResize = "HEIGHT";
      pctNode.layoutSizingHorizontal = "FIXED";
      pctNode.y = Math.round((size - pctNode.height) / 2);
      const ring = b.canvas("Progress ring", size, size, [track, arc, pctNode]);
      const lbl = clean(block.label ?? block.title, 120);
      const caption = clean(block.caption ?? block.subtitle, 200);
      if (!lbl && !caption) return ring;
      const textW = W - size - 16;
      const kids: NativeNode[] = [];
      if (lbl) kids.push(b.text("Progress label", lbl, textW, { size: 15, weight: "Semi Bold", color: t.text, bg }));
      if (caption) kids.push(b.text("Progress caption", caption, textW, { size: 13, color: t.muted, bg }));
      const textStack = kids.length > 1 ? b.vstack("Progress text", textW, kids, { gap: 4 }) : kids[0];
      textStack.layoutGrow = 1;
      return b.hstack(label(lbl || centerText, "Progress indicator"), W, [ring, textStack], { gap: 16, align: "CENTER" });
    }
    case "progress_bar": {
      const pct = percent(block.percent ?? block.value ?? block.progress);
      const lbl = clean(block.label ?? block.title, 120);
      const valueText = clean(block.valueText ?? block.value_text ?? block.right, 40) || (lbl ? Math.round(pct) + "%" : "");
      const kids: NativeNode[] = [];
      if (lbl) {
        const v = valueText ? b.text("Progress value", valueText, W / 2, { size: 13, weight: "Medium", color: t.text, bg, hug: true }) : null;
        const l = b.text("Progress label", lbl, W - (v ? v.width + 8 : 0), { size: 13, color: t.muted, bg });
        l.layoutGrow = 1;
        kids.push(v ? b.hstack("Progress header", W, [l, v], { justify: "SPACE_BETWEEN" }) : l);
      }
      const fillColor = tone(block.tone) === "neutral" ? t.primary : toneColor(t, tone(block.tone));
      const fill = b.rect("Progress fill", Math.max(4, (W * pct) / 100), 8, fillColor, { cornerRadius: 4 });
      const barTrack = b.canvas("Progress track", W, 8, [fill]);
      delete barTrack.noFill;
      barTrack.color = t.dark ? t.surfaceAlt : t.border;
      barTrack.cornerRadius = 4;
      barTrack.clipsContent = true;
      barTrack.layoutSizingHorizontal = "FILL";
      kids.push(barTrack);
      const caption = clean(block.caption, 200);
      if (caption) kids.push(b.text("Progress caption", caption, W, { size: 12, color: t.muted, bg }));
      return kids.length === 1 ? kids[0] : b.vstack(label(lbl, "Progress bar"), W, kids, { gap: 6 });
    }
    case "button": {
      const text = clean(block.label ?? block.text ?? block.title, 60);
      if (!text) return null;
      const variant = clean(block.variant ?? block.style ?? block.kind, 20).toLowerCase();
      const isText = /text|link|ghost|tertiary/.test(variant);
      const isSecondary = !isText && /secondary|outline|outlined/.test(variant);
      const fill = isText ? null : isSecondary ? t.surface : t.primaryFill;
      const fg = isText || isSecondary ? t.primary : t.onPrimary;
      const textNode = b.text("Button label", text, W - 32, { size: 15, weight: "Semi Bold", color: fg, bg: fill ?? bg, align: "CENTER", hug: true });
      const btn = b.hstack(label(text, isText ? "Text button" : isSecondary ? "Secondary button" : "Primary button"), W, [textNode], {
        pad: [12, 16, 12, 16], fill, radius: t.radius, stroke: isSecondary ? t.primary : undefined, justify: "CENTER", align: "CENTER", fixedHeight: isText ? undefined : 48,
      });
      return btn;
    }
    case "buttons": {
      const items = arr(block.items ?? block.buttons ?? block.actions).map((item) => typeof item === "string" ? { label: item } : asRec(item)).filter((x): x is Rec => !!x).slice(0, 3);
      if (!items.length) return null;
      const horizontal = clean(block.layout ?? block.direction, 20).toLowerCase() === "horizontal" && items.length <= 2;
      const each = horizontal ? Math.floor((W - 12) / items.length) : W;
      const nodes = items.map((item, index) => expandLeaf(ctx, { ...item, variant: item.variant ?? (index === 0 ? "primary" : "secondary") }, "button", each, depth + 1)).filter((x): x is NativeNode => !!x);
      if (horizontal) nodes.forEach((n) => { n.layoutGrow = 1; });
      return horizontal ? b.hstack("Actions", W, nodes, { gap: 12 }) : b.vstack("Actions", W, nodes, { gap: 8 });
    }
    case "input": {
      const lbl = clean(block.label ?? block.title, 120);
      const value = clean(block.value, 200);
      const placeholder = clean(block.placeholder ?? block.hint, 200);
      const error = clean(block.error, 200);
      const helper = clean(block.helper ?? block.helperText ?? block.caption, 200);
      const isSelect = /dropdown|select/.test(clean(block.type, 20).toLowerCase()) || block.dropdown === true;
      const fieldText = b.text(value ? "Input value" : "Input placeholder", value || placeholder || " ", W - 32 - (isSelect ? 24 : 0), { size: 15, color: value ? t.text : t.muted, bg: t.surface });
      fieldText.layoutGrow = 1;
      const fieldKids = [fieldText];
      if (isSelect && depth + 2 <= MAX_DEPTH) fieldKids.push(b.text("Dropdown chevron", "⌄", 24, { size: 16, color: t.muted, bg: t.surface, hug: true }));
      const field = b.hstack("Input field", W, fieldKids, { pad: [12, 16, 12, 16], fill: t.surface, radius: Math.min(t.radius, 12), stroke: error ? t.danger : t.border, fixedHeight: 48 });
      const kids: NativeNode[] = [];
      if (lbl) kids.push(b.text("Input label", lbl, W, { size: 13, weight: "Medium", color: t.text, bg }));
      kids.push(field);
      if (error) kids.push(b.text("Input error", error, W, { size: 12, color: t.danger, bg }));
      else if (helper) kids.push(b.text("Input helper", helper, W, { size: 12, color: t.muted, bg }));
      return b.vstack(label(lbl || placeholder, "Input"), W, kids, { gap: 6 });
    }
    case "tabs":
    case "chips":
    case "bottom_nav": {
      const items = arr(block.items ?? block.tabs ?? block.options ?? block.chips).map((item) => clean(typeof item === "string" ? item : asRec(item)?.label ?? asRec(item)?.text, 40)).filter(Boolean).slice(0, type === "chips" ? 8 : 5);
      if (!items.length) return null;
      const activeRaw = block.active ?? block.selected ?? 0;
      const active = typeof activeRaw === "number" ? activeRaw : Math.max(0, items.findIndex((x) => x === clean(activeRaw, 40)));
      if (type === "chips") {
        const chips = items.map((item, i) => {
          const on = i === active;
          const fill = on ? mix(t.surface, t.primary, t.dark ? 0.3 : 0.14) : t.surface;
          const txt = b.text("Chip label", item, W, { size: 13, weight: on ? "Semi Bold" : "Regular", color: on ? t.primary : t.text, bg: fill, hug: true });
          return b.hstack(label(item, on ? "Chip (selected)" : "Chip"), 0, [txt], { pad: [6, 12, 6, 12], fill, radius: 100, stroke: on ? t.primary : t.border, hugWidth: true });
        });
        // Split into explicit rows instead of relying on wrap, so widths stay inside the parent.
        const lines: NativeNode[][] = [[]];
        let used = 0;
        for (const chip of chips) {
          if (used > 0 && used + 8 + chip.width > W) { lines.push([]); used = 0; }
          used += (used > 0 ? 8 : 0) + chip.width;
          lines[lines.length - 1].push(chip);
        }
        const rows = lines.map((line, i) => b.hstack(lines.length > 1 ? "Chips row " + (i + 1) : "Chips", W, line, { gap: 8, align: "CENTER" }));
        return rows.length === 1 ? rows[0] : b.vstack("Chips", W, rows, { gap: 8 });
      }
      const gap = type === "tabs" ? 4 : 0;
      const cell = Math.floor((W - 8 - gap * (items.length - 1)) / items.length);
      const segFill = type === "tabs" ? t.surfaceAlt : t.surface;
      const cells = items.map((item, i) => {
        const on = i === active;
        const fill = type === "tabs" && on ? t.surface : null;
        const txt = b.text(type === "tabs" ? "Tab label" : "Nav label", item, cell - 8, { size: 13, weight: on ? "Semi Bold" : "Regular", color: on ? t.primary : t.muted, bg: fill ?? segFill, align: "CENTER" });
        const seg = b.hstack(label(item, on ? (type === "tabs" ? "Tab (active)" : "Nav item (active)") : (type === "tabs" ? "Tab" : "Nav item")), cell, [txt], { pad: [8, 4, 8, 4], fill, radius: Math.max(0, t.radius - 4), justify: "CENTER", align: "CENTER", fixedHeight: 44 });
        seg.layoutGrow = 1;
        return seg;
      });
      return b.hstack(type === "tabs" ? "Tabs" : "Bottom navigation", W, cells, { gap, pad: [4, 4, 4, 4], fill: segFill, radius: type === "tabs" ? t.radius : 0, stroke: type === "bottom_nav" ? t.border : undefined });
    }
    case "banner": {
      const title = clean(block.title ?? block.text, 160);
      const body = clean(block.body ?? block.description ?? block.message, 400);
      if (!title && !body) return null;
      const kind = tone(block.tone ?? block.variant ?? "info");
      const color = kind === "neutral" ? t.primary : toneColor(t, kind);
      const fill = mix(t.surface, color, t.dark ? 0.18 : 0.08);
      const inner = W - 32;
      const kids: NativeNode[] = [];
      if (title) kids.push(b.text("Banner title", title, inner, { size: 15, weight: "Semi Bold", color: t.text, bg: fill }));
      if (body) kids.push(b.text("Banner body", body, inner, { size: 13, color: t.text, bg: fill }));
      const action = clean(block.action ?? block.cta, 40);
      if (action) kids.push(b.text("Banner action", action, inner, { size: 14, weight: "Semi Bold", color, bg: fill, hug: true }));
      return b.vstack(label(title || body, "Banner"), W, kids, { gap: 6, pad: [14, 16, 14, 16], fill, radius: t.radius, stroke: mix(t.surface, color, 0.35) });
    }
    case "divider":
      return b.rect("Divider", W, 1, t.border, { layoutSizingHorizontal: "FILL" });
    case "checkbox": {
      const lbl = clean(block.label ?? block.text, 400);
      if (!lbl) return null;
      const checked = block.checked === true || block.value === true || block.on === true;
      const boxFill = checked ? t.primaryFill : t.surface;
      const boxKids = checked && depth + 2 <= MAX_DEPTH ? [b.text("Check", "✓", 20, { size: 13, weight: "Bold", color: t.onPrimary, bg: boxFill, align: "CENTER", hug: true })] : [];
      const box = b.hstack(checked ? "Checkbox (checked)" : "Checkbox", 20, boxKids, { fill: boxFill, radius: 4, stroke: checked ? t.primary : t.muted, justify: "CENTER", align: "CENTER", fixedHeight: 20 });
      box.layoutSizingHorizontal = "FIXED";
      const text = b.text("Checkbox label", lbl, W - 32, { size: 13, color: t.text, bg });
      text.layoutGrow = 1;
      return b.hstack(label(lbl, "Checkbox row"), W, [box, text], { gap: 12, align: "MIN" });
    }
    case "skeleton":
      return skeletonNode(ctx, block, W);
    case "image": {
      // A loading state draws text-free skeleton shapes, never "Illustration"/"Loading" boxes.
      if (ctx.skeleton) return skeletonNode(ctx, { ...block, lines: 1 }, W);
      const caption = clean(block.label ?? block.alt ?? block.text, 120) || "Illustration";
      const h = Math.max(48, Math.min(320, typeof block.height === "number" ? block.height : 140));
      const txt = b.text("Image label", caption, W - 32, { size: 13, color: t.muted, bg: t.surfaceAlt, align: "CENTER" });
      return b.hstack(label(caption, "Image placeholder"), W, [txt], { fill: t.surfaceAlt, radius: t.radius, justify: "CENTER", align: "CENTER", fixedHeight: h, pad: [16, 16, 16, 16] });
    }
    case "otp": {
      const length = Math.max(4, Math.min(8, typeof block.length === "number" ? block.length : 6));
      const value = clean(block.value, 8);
      const gap = 8;
      const box = Math.min(52, Math.floor((W - gap * (length - 1)) / length));
      const boxes = Array.from({ length }, (_, i) => {
        const ch = value[i] ?? "";
        const kids = ch && depth + 2 <= MAX_DEPTH ? [b.text("OTP digit", ch, box, { size: 20, weight: "Semi Bold", color: t.text, bg: t.surface, align: "CENTER", hug: true })] : [];
        const node = b.hstack("OTP box " + (i + 1), box, kids, { fill: t.surface, radius: 8, stroke: i === value.length ? t.primary : t.border, justify: "CENTER", align: "CENTER", fixedHeight: box });
        node.layoutSizingHorizontal = "FIXED";
        return node;
      });
      return b.hstack("OTP input", W, boxes, { gap });
    }
    case "steps": {
      const items = arr(block.items ?? block.steps).map((item) => typeof item === "string" ? { label: item } : asRec(item)).filter((x): x is Rec => !!x).slice(0, 6);
      if (!items.length) return null;
      const current = typeof block.current === "number" ? block.current : 0;
      const rows = items.map((item, i) => {
        const done = i < current || item.done === true;
        const on = i === current;
        const dotFill = done || on ? t.primaryFill : t.surfaceAlt;
        const dot = b.hstack("Step marker", 24, [b.text("Step number", done ? "✓" : String(i + 1), 24, { size: 12, weight: "Semi Bold", color: done || on ? t.onPrimary : t.muted, bg: dotFill, align: "CENTER", hug: true })], { fill: dotFill, radius: 100, justify: "CENTER", align: "CENTER", fixedHeight: 24 });
        dot.layoutSizingHorizontal = "FIXED";
        const lbl = b.text("Step label", clean(item.label ?? item.title, 160), W - 36, { size: 14, weight: on ? "Semi Bold" : "Regular", color: done || on ? t.text : t.muted, bg });
        lbl.layoutGrow = 1;
        return b.hstack(label(clean(item.label ?? item.title, 60), on ? "Step (current)" : done ? "Step (done)" : "Step"), W, [dot, lbl], { gap: 12 });
      });
      return b.vstack("Steps", W, rows, { gap: 10 });
    }
    case "component": {
      const componentId = clean(block.componentId ?? block.component_id ?? block.id, 100);
      if (!componentId || !ctx.componentIds.has(componentId)) {
        b.warnings.push("Dropped component block with unknown componentId " + (componentId || "(missing)") + ".");
        return null;
      }
      b.count += 1;
      const props = asRec(block.instanceProperties ?? block.properties ?? block.props);
      const height = typeof block.height === "number" && Number.isFinite(block.height) ? Math.max(1, Math.min(800, block.height)) : 48;
      const width = typeof block.width === "number" && Number.isFinite(block.width) ? Math.max(1, Math.min(W, block.width)) : W;
      const node: NativeNode = { type: "INSTANCE", name: clean(block.name, 80) || "Component", componentId, x: 0, y: 0, width, height,
        layoutSizingHorizontal: width >= W ? "FILL" : "FIXED" };
      if (props) {
        const entries = Object.entries(props).filter((e): e is [string, string | boolean] => typeof e[1] === "string" || typeof e[1] === "boolean").slice(0, 30);
        if (entries.length) node.instanceProperties = Object.fromEntries(entries);
      }
      return node;
    }
    case "custom": {
      const raw = asRec(block.node ?? block.element ?? block.frame);
      if (!raw || typeof raw.type !== "string") return null;
      const node = clampCustom(raw, W, depth, b);
      return node;
    }
    default:
      return null;
  }
}

/** Escape hatch: accept a raw native node, bounded to the available width and depth. */
function clampCustom(raw: Rec, width: number, depth: number, b: Builder): NativeNode | null {
  if (depth > MAX_DEPTH) return null;
  const type = clean(raw.type, 20).toUpperCase();
  if (!["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR"].includes(type)) return null;
  b.count += 1;
  const node: NativeNode = { ...raw, type, name: clean(raw.name, 80) || "Custom " + type.toLowerCase(),
    x: typeof raw.x === "number" ? raw.x : 0, y: typeof raw.y === "number" ? raw.y : 0,
    width: Math.max(1, Math.min(width, typeof raw.width === "number" ? raw.width : width)),
    height: Math.max(1, typeof raw.height === "number" ? raw.height : 40) } as NativeNode;
  if (type === "FRAME") {
    if (!hex(node.color) && node.noFill !== true) node.noFill = true;
    const kids = arr(raw.children).map(asRec).filter((x): x is Rec => !!x)
      .map((child) => clampCustom(child, node.width, depth + 1, b)).filter((x): x is NativeNode => !!x);
    if (kids.length) node.children = kids; else delete node.children;
  } else {
    delete node.children;
  }
  return node;
}

function expandCard(ctx: Ctx, block: Rec, width: number, depth: number, nameFallback: string): NativeNode | null {
  const { b, t } = ctx;
  const inner = width - 32;
  const cardCtx: Ctx = { ...ctx, bg: t.surface };
  const kids: NativeNode[] = [];
  const title = clean(block.title ?? block.heading, 160);
  const subtitle = clean(block.subtitle ?? block.caption, 240);
  const badge = asRec(block.badge) ?? (typeof block.badge === "string" || typeof block.status === "string" ? { text: block.badge ?? block.status, tone: block.badgeTone ?? block.statusTone } : null);
  if (title || subtitle || badge) {
    const badgeNodeValue = badge && clean(badge.text ?? badge.label, 40) ? badgeNode(cardCtx, clean(badge.text ?? badge.label, 40), tone(badge.tone ?? badge.text)) : null;
    const textW = inner - (badgeNodeValue ? badgeNodeValue.width + 12 : 0);
    const titleKids: NativeNode[] = [];
    if (title) titleKids.push(b.text("Card title", title, textW, { size: 16, weight: "Semi Bold", color: t.text, bg: t.surface }));
    if (subtitle) titleKids.push(b.text("Card subtitle", subtitle, textW, { size: 13, color: t.muted, bg: t.surface }));
    const titleNode = titleKids.length > 1 ? b.vstack("Card heading", textW, titleKids, { gap: 2 }) : titleKids[0];
    if (titleNode) titleNode.layoutGrow = 1;
    const headerKids = [titleNode, badgeNodeValue].filter((x): x is NativeNode => !!x);
    kids.push(headerKids.length > 1 ? b.hstack("Card header", inner, headerKids, { gap: 12, justify: "SPACE_BETWEEN", align: "MIN" }) : headerKids[0]);
  }
  for (const child of alignRowLeading(arr(block.blocks ?? block.children ?? block.items ?? block.content).map(asRec).filter((x): x is Rec => !!x))) {
    const rec = asRec(child);
    if (!rec) continue;
    const type = blockType(rec);
    if (type === "card") {
      // Cards never nest: keep the content, drop the extra surface.
      b.warnings.push("Flattened a card nested inside another card.");
      const nested = expandCard(cardCtx, rec, width, depth, "Card");
      if (nested?.children) kids.push(...nested.children.map((n) => ({ ...n })));
      b.count -= 1;
      continue;
    }
    kids.push(...expandBlock(cardCtx, rec, inner, depth + 1));
  }
  if (!kids.length) return null;
  const name = clean(block.name, 80) || (title ? label(title, "Card") : nameFallback);
  return b.vstack(name, width, kids, { gap: 12, pad: [16, 16, 16, 16], fill: t.surface, radius: t.radius, stroke: t.border });
}

function expandBlock(ctx: Ctx, block: Rec, width: number, depth: number): NativeNode[] {
  const type = blockType(block) || inferBlockType(block);
  if (!type) {
    ctx.b.warnings.push("Dropped a block with unknown type " + JSON.stringify(clean(block.type, 30)) + ".");
    return [];
  }
  if (type === "card") {
    const card = expandCard(ctx, block, width, depth, "Card");
    return card ? [card] : [];
  }
  if (type === "list") {
    // Rows go straight into the parent (no list wrapper) so lists inside cards stay within depth.
    const rows = arr(block.items ?? block.rows).map((item) => asRec(item) ?? (typeof item === "string" ? { label: item } : null)).filter((x): x is Rec => !!x).slice(0, 20);
    const nodes: NativeNode[] = [];
    rows.forEach((row) => {
      const node = expandLeaf(ctx, { chevron: block.chevron, ...row }, "row", width, depth);
      if (!node) return;
      if (nodes.length && block.dividers !== false) nodes.push(ctx.b.rect("Divider", width, 1, ctx.t.border, { layoutSizingHorizontal: "FILL" }));
      nodes.push(node);
    });
    return nodes;
  }
  const node = expandLeaf(ctx, block, type, width, depth);
  return node ? [node] : [];
}

/** Hoist children of frames that would sit deeper than the plan allows, keeping every text layer. */
function fitDepth(nodes: NativeNode[], depth: number, warnings: string[]): NativeNode[] {
  const out: NativeNode[] = [];
  for (const node of nodes) {
    if (!node.children?.length) { out.push(node); continue; }
    if (depth >= MAX_DEPTH) {
      warnings.push("Flattened \"" + node.name + "\" to stay within the layer depth limit.");
      out.push(...fitDepth(node.children, depth, warnings));
      continue;
    }
    node.children = fitDepth(node.children, depth + 1, warnings);
    out.push(node);
  }
  return out;
}

function countNodes(nodes: NativeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.children ? countNodes(node.children) : 0), 0);
}

/**
 * Give every Auto Layout child real, non-overlapping coordinates and an explicit AUTO
 * positioning. normalizePlan infers overlays from overlapping geometry, so identical
 * x/y values would wrongly turn flow children into absolute overlays.
 */
function assignPositions(parent: Rec, children: NativeNode[]) {
  const mode = String(parent.layoutMode || "NONE");
  const gap = typeof parent.itemSpacing === "number" ? parent.itemSpacing : 0;
  let x = typeof parent.paddingLeft === "number" ? parent.paddingLeft : 0;
  let y = typeof parent.paddingTop === "number" ? parent.paddingTop : 0;
  for (const child of children) {
    if (mode === "VERTICAL" || mode === "HORIZONTAL") {
      if (child.layoutPositioning !== "ABSOLUTE") {
        child.layoutPositioning = "AUTO";
        child.x = Math.round(x);
        child.y = Math.round(y);
        if (mode === "VERTICAL") y += child.height + gap; else x += child.width + gap;
      }
    }
    if (child.children?.length) assignPositions(child, child.children);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Last-resort spec rebuilt from the source layer tree when no model answer could be rendered:
 * every source text is kept in its original order and grouping, so the user gets a native,
 * auto-layout copy of the screen instead of an error.
 */
export function sourceFallbackSpec(canvas: Record<string, unknown>): Rec | null {
  const root = asRec(arr(canvas.nodes)[0]);
  if (!root) return null;
  const rootFill = Array.isArray(root.fillColors) ? hex(root.fillColors[0]) : null;
  const visible = (node: Rec | null): node is Rec => !!node && node.visible !== false;
  const kids = (node: Rec) => arr(node.children).map(asRec).filter(visible);
  const textOf = (node: Rec) => (node.type === "TEXT" ? clean(node.text, 1200) : "");
  // A horizontal row of 2–5 single-label items (tab components) is one tabs block, not
  // separate sections. The active tab is the fully opaque label.
  const tabItems = (node: Rec): { items: string[]; active: number } | null => {
    const children = kids(node);
    if (node.layoutMode !== "HORIZONTAL" || children.length < 2 || children.length > 5) return null;
    const labels = children.map((c) => kids(c).filter((d) => d.type === "TEXT"));
    if (!labels.every((l) => l.length === 1 && clean(l[0].text, 40))) return null;
    const active = labels.findIndex((l) => (typeof l[0].opacity === "number" ? l[0].opacity : 1) >= 0.99);
    return { items: labels.map((l) => clean(l[0].text, 40)), active: Math.max(0, active) };
  };
  // Flatten structural wrappers (e.g. "Screen body") so each real group becomes a section.
  const groups: Rec[] = [];
  const addGroups = (nodes: Rec[], depth: number) => {
    for (const node of nodes) {
      const children = kids(node);
      if (depth < 2 && node.type !== "INSTANCE" && children.length >= 2 && children.every((c) => c.type !== "TEXT") && !node.fillColors && !node.strokeColors && !tabItems(node)) {
        addGroups(children, depth + 1);
      } else {
        groups.push(node);
      }
    }
  };
  addGroups(kids(root), 0);

  const blocksOf = (node: Rec, depth: number, out: Rec[]) => {
    if (depth > 10 || out.length >= 24) return;
    if (node.type === "TEXT") { const text = textOf(node); if (text) out.push({ type: "text", text }); return; }
    const tabs = tabItems(node);
    if (tabs) { out.push({ type: "tabs", items: tabs.items, active: tabs.active }); return; }
    const children = kids(node);
    const texts = children.filter((c) => c.type === "TEXT").map(textOf).filter(Boolean);
    const filled = Array.isArray(node.fillColors) && node.fillColors.length > 0;
    // A small filled pill with one label (status "Current", "Matured") is a badge, not a button.
    if (texts.length === 1 && filled && typeof node.height === "number" && node.height <= 24 && children.length <= 3) {
      out.push({ type: "badge", text: texts[0] });
      return;
    }
    if (texts.length === 1 && children.length <= 2 && filled && typeof node.height === "number" && node.height <= 64 && typeof node.cornerRadius === "number") {
      out.push({ type: "button", label: texts[0] });
      return;
    }
    if (texts.length === 2 && children.length === 2) { out.push({ type: "row", label: texts[0], value: texts[1] }); return; }
    for (const child of children) blocksOf(child, depth + 1, out);
  };

  const sections: Rec[] = [];
  for (const [index, group] of groups.entries()) {
    if (sections.length >= 8) break;
    const name = clean(group.name, 60) || "Section " + (index + 1);
    if (index === 0 && group.type === "INSTANCE") {
      // The renderer swaps this for the source header component when it is in the catalogue.
      const title = kids(group).map(textOf).find(Boolean) || clean(group.name, 60);
      sections.push({ name, blocks: [{ type: "app_bar", title }] });
      continue;
    }
    const blocks: Rec[] = [];
    blocksOf(group, 0, blocks);
    if (!blocks.length) continue;
    // Component cards often carry their fill on the first inner frame, not the instance.
    const surfaceNode = [group, kids(group)[0]].find((n) => n && (Array.isArray(n.fillColors) || Array.isArray(n.strokeColors))) ?? group;
    const fill = Array.isArray(surfaceNode.fillColors) ? hex(surfaceNode.fillColors[0]) : null;
    const card = (fill && fill !== rootFill) || Array.isArray(surfaceNode.strokeColors);
    sections.push({ name, surface: card ? "card" : "plain", blocks });
  }
  if (sections.length > 8) sections.length = 8;
  return sections.length ? { summary: "Source-preserving layout: the model response could not be used, so UX Direct rebuilt the screen natively from its own layers.", sections, learningCandidate: null } : null;
}

/**
 * Bind generated layers to the file's own styles: a TEXT layer takes a local text style with
 * the same size (±1px) and weight class, and any exact colour match takes the paint style.
 * Hygiene checks otherwise report every generated layer as hard-coded.
 */
function bindFileStyles(elements: NativeNode[], styles: Rec | null, warnings: string[]) {
  if (!styles) return;
  const textStyles = arr(styles.text).map(asRec).filter((x): x is Rec => !!x && typeof x.id === "string" && typeof x.fontSize === "number");
  const paintByColor = new Map<string, string>();
  for (const style of arr(styles.paint).map(asRec)) {
    if (style && typeof style.id === "string" && typeof style.color === "string" && !paintByColor.has(style.color.toUpperCase())) paintByColor.set(style.color.toUpperCase(), style.id);
  }
  let texts = 0, paints = 0;
  const visit = (nodes: NativeNode[]) => {
    for (const node of nodes) {
      if (node.type === "TEXT" && typeof node.textStyleId !== "string" && textStyles.length) {
        const size = typeof node.fontSize === "number" ? node.fontSize : 14;
        const bold = isBoldWeight(String(node.fontStyle ?? "Regular"));
        const fits = textStyles.filter((st) => Math.abs(Number(st.fontSize) - size) <= 1 && isBoldWeight(String(st.fontStyle ?? "Regular")) === bold);
        const pick = fits.find((st) => st.fontFamily === node.fontFamily && Number(st.fontSize) === size) ??
          fits.find((st) => Number(st.fontSize) === size) ?? fits[0];
        if (pick) {
          node.textStyleId = pick.id;
          node.fontSize = Number(pick.fontSize);
          if (typeof pick.fontFamily === "string") node.fontFamily = pick.fontFamily;
          if (typeof pick.fontStyle === "string") node.fontStyle = pick.fontStyle;
          texts += 1;
        }
      }
      if (node.type !== "CLONE" && node.type !== "INSTANCE" && typeof node.color === "string" && typeof node.paintStyleId !== "string") {
        const id = paintByColor.get(node.color.toUpperCase());
        if (id) { node.paintStyleId = id; paints += 1; }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(elements);
  if (texts || paints) warnings.push("Bound " + texts + " text layer(s) and " + paints + " fill(s) to the file's own styles.");
}

export function isBlockSpec(value: unknown): boolean {
  const rec = asRec(value);
  return !!rec && Array.isArray(rec.sections) && !Array.isArray(rec.elements);
}

export function expandBlockSpec(value: unknown, canvas: Record<string, unknown>, options: { componentSelection?: boolean; sourceCanvas?: Record<string, unknown> | null; allowClones?: boolean; monochrome?: boolean; contentDropped?: boolean; skeleton?: boolean } = {}): BlockExpansion {
  const spec = asRec(value) ?? {};
  const sourceNodes = arr(canvas.nodes);
  const source = asRec(sourceNodes[0]) ?? {};
  const sourceFill = Array.isArray(source.fillColors) ? hex(source.fillColors[0]) : null;
  const rawFrame = asRec(spec.frame) ?? {};
  const ctaFill = options.monochrome ? null : sourceCtaFill(options.sourceCanvas ?? canvas);
  const theme = resolveTheme(spec.theme ?? rawFrame.theme, hex(rawFrame.backgroundColor) ?? sourceFill, ctaFill);
  const componentIds = new Set(arr(canvas.components).map((c) => asRec(c)?.id).filter((id): id is string => typeof id === "string"));
  const b = new Builder(theme, collectSourceTokens(canvas, componentIds));
  const ctx: Ctx = { b, t: theme, bg: theme.background, componentIds, skeleton: options.skeleton === true };

  const sourceWidth = typeof source.width === "number" ? source.width : 0;
  const sourceHeight = typeof source.height === "number" ? source.height : 0;
  const frameWidth = Math.round(Math.max(280, Math.min(1440, typeof rawFrame.width === "number" ? rawFrame.width : sourceWidth || 360)));
  const pad = options.componentSelection ? 12 : 16;
  const gap = options.componentSelection ? 12 : 16;
  const content = frameWidth - pad * 2;

  const errors: string[] = [];
  const elements: NativeNode[] = [];
  let blockCount = 0;
  const sections = mergeExtraSections(arr(spec.sections).map(asRec).filter((x): x is Rec => !!x));
  if (!sections.length) errors.push("sections must be a non-empty array of {name, blocks:[...]}.");
  for (const [index, section] of sections.slice(0, 8).entries()) {
    const blocks = sectionBlocks(section);
    blockCount += blocks.length;
    const name = clean(section.name ?? section.title, 80) || "Section " + (index + 1);
    const surface = clean(section.surface ?? section.style, 20).toLowerCase();
    // A section is either a card surface itself or a plain stack of blocks (which may include cards).
    if (surface === "card") {
      const card = expandCard(ctx, { ...section, name, blocks }, content, 0, name);
      if (card) elements.push(card);
      continue;
    }
    const sectionTitle = clean(section.title, 160);
    const kids: NativeNode[] = [];
    if (sectionTitle && sectionTitle !== clean(section.name, 160)) kids.push(b.text("Section title", sectionTitle, content, { size: 17, weight: "Semi Bold", color: theme.text, bg: theme.background }));
    for (const block of blocks) kids.push(...expandBlock(ctx, block, content, 1));
    if (!kids.length) {
      b.warnings.push("Section \"" + name + "\" produced no layers and was skipped.");
      continue;
    }
    elements.push(b.vstack(name, content, kids, { gap: 12 }));
  }
  // Too few sections: split plain multi-block sections rather than rejecting a usable spec.
  while (elements.length > 0 && elements.length < 3) {
    const index = elements.findIndex((node) => node.noFill === true && node.layoutMode === "VERTICAL" && (node.children?.length ?? 0) >= 2);
    if (index < 0) break;
    const node = elements[index];
    const [head, ...rest] = node.children!;
    elements.splice(index, 1, b.vstack(node.name, content, [head], { gap: 12 }), b.vstack(node.name + " (cont.)", content, rest, { gap: 12 }));
  }
  if (sections.length && elements.length === 0) {
    errors.push("No section produced layers; return 3–8 sections whose blocks use the listed block types (row, text, stat, list, button...).");
  }
  // A reused source header sits full-bleed at the top like the source; the other sections keep
  // their 16px side margins through their own padding, so the plan still has 3–8 framed sections.
  let rootPad: [number, number, number, number] = [pad, pad, pad, pad];
  const headerHost = b.headerNode ? elements.findIndex((node) => node === b.headerNode || (node.children?.length === 1 && node.children[0] === b.headerNode)) : -1;
  if (headerHost === 0 && b.headerNode) {
    const header = b.headerNode;
    header.width = frameWidth;
    const host = elements[0] === header ? b.vstack(header.name + " section", frameWidth, [header]) : elements[0];
    host.width = frameWidth;
    elements[0] = host;
    for (let i = 1; i < elements.length; i += 1) {
      const node = elements[i];
      if (node.type === "FRAME" && node.noFill === true && node.layoutMode === "VERTICAL") {
        node.paddingLeft = pad; node.paddingRight = pad; node.width = frameWidth;
      } else {
        elements[i] = b.vstack(node.name + " section", frameWidth, [node], { pad: [0, pad, 0, pad] });
      }
    }
    rootPad = [0, 0, pad, 0];
  }
  const fitted = fitDepth(elements, 0, b.warnings);
  elements.splice(0, elements.length, ...fitted);
  const renderedCount = countNodes(elements);
  if (renderedCount > BLOCK_NODE_BUDGET) {
    errors.push("The spec expands to " + renderedCount + " native layers, over the " + BLOCK_NODE_BUDGET + "-layer budget. Merge rows into lists, drop decorative blocks, and keep every source text.");
  } else {
    // Logos, icons, charts and images are not in the block spec: clone them from the source.
    const fidelity = restoreSourceFidelity(elements, options.sourceCanvas ?? canvas, theme, {
      // Older plugin builds cannot run CLONE elements: they still get the button restore.
      budget: options.allowClones === false ? 0 : Math.min(SOURCE_GRAPHIC_BUDGET, PLAN_NODE_LIMIT - renderedCount - 10),
      headerComponentId: b.source?.header?.componentId ?? null,
      contentDropped: options.contentDropped,
    });
    // Wireframes: copied logos, icons and charts are recoloured to the wireframe ink and images
    // become grey boxes, so white source icons don't vanish on the light theme (findings 41, 43).
    if (options.monochrome) {
      const mark = (nodes: NativeNode[]) => { for (const n of nodes) { if (n.type === "CLONE" || n.type === "INSTANCE") n.monochrome = { ink: theme.text, placeholder: theme.surfaceAlt }; if (n.children) mark(n.children); } };
      mark(elements);
    }
    if (fidelity.clones || fidelity.restoredButtons) {
      b.warnings.push("Kept " + fidelity.clones + " source graphic(s)" + (fidelity.replacedRings ? " (" + fidelity.replacedRings + " real chart(s) replaced generated rings)" : "") +
        (fidelity.restoredButtons ? " and restored " + fidelity.restoredButtons + " source button(s)" : "") + ".");
    }
    if (fidelity.unplaced.length && options.allowClones === false) b.warnings.push(fidelity.unplaced.length + " source graphic(s) were not copied: this plugin build cannot copy layers. Re-import the latest UX Direct plugin zip.");
    else if (fidelity.unplaced.length) b.warnings.push("Could not place " + fidelity.unplaced.length + " source graphic(s): " + fidelity.unplaced.slice(0, 5).join(", ") + ".");
  }
  bindFileStyles(elements, asRec(canvas.styles), b.warnings);
  const nodeCount = countNodes(elements);

  const contentHeight = rootPad[0] + rootPad[2] + elements.reduce((sum, node) => sum + node.height, 0) + Math.max(0, elements.length - 1) * gap;
  const requestedHeight = typeof rawFrame.height === "number" ? rawFrame.height : sourceHeight || 800;
  const fits = contentHeight <= requestedHeight;
  const frame: Rec = {
    // A wireframe is named like the plugin's states pack ("15 / Wireframe"), whatever the model called it.
    name: options.monochrome && clean(source.name, 60) ? clean(source.name, 60) + " / Wireframe"
      : clean(rawFrame.name, 80) || (clean(source.name, 60) ? clean(source.name, 60) + " · UX Direct" : "UX Direct Variation"),
    width: frameWidth,
    height: Math.round(Math.max(360, Math.min(4096, fits ? requestedHeight : contentHeight))),
    backgroundColor: theme.background,
    layoutMode: "VERTICAL", itemSpacing: gap,
    paddingTop: rootPad[0], paddingRight: rootPad[1], paddingBottom: rootPad[2], paddingLeft: rootPad[3],
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
    primaryAxisSizingMode: fits ? "FIXED" : "AUTO", counterAxisSizingMode: "FIXED",
  };
  assignPositions(frame, elements);
  const summary = clean(spec.summary, 700) || "A UX Direct native design variation built from " + blockCount + " design blocks.";
  return {
    plan: errors.length ? null : { summary: summary.length >= 8 ? summary : summary + " (UX Direct)", frame, elements, ...(spec.learningCandidate !== undefined ? { learningCandidate: spec.learningCandidate } : {}) },
    warnings: b.warnings.slice(0, 12),
    errors,
    nodeCount,
    blockCount,
  };
}

/** Prompt contract for block mode. Kept short on purpose: weaker models follow short contracts. */
export const BLOCK_SPEC_CONTRACT = [
  "OUTPUT FORMAT — BLOCK SPEC. You decide WHAT to show; UX Direct's renderer builds the native Figma layers, Auto Layout, spacing, typography and contrast. Never output coordinates, sizes, paddings or layout modes.",
  "Return ONLY one JSON object: {\"summary\": string, \"frame\": {\"name\": string}, \"theme\": {\"background\",\"surface\",\"text\",\"muted\",\"primary\",\"onPrimary\",\"border\": \"#RRGGBB\", \"radius\": number} (all optional — copy the source's colours), \"sections\": [ {\"name\": string, \"surface\": \"plain\"|\"card\", \"title\"?: string, \"blocks\": [ ... ]} ], \"learningCandidate\": null}.",
  "Use 3–8 sections named after their real content (e.g. \"Loan summary\", \"Repayment schedule\", \"Actions\"). surface \"card\" makes the whole section one card.",
  "BLOCKS (type + fields; omit fields you do not need):",
  "- app_bar {title, subtitle?, back?: bool, action?: string}",
  "- heading {title, subtitle?}",
  "- text {text, tone?: body|muted|caption}",
  "- stat {label?, value, caption?, tone?}  — one big number/amount",
  "- stat_row {items:[{label, value, caption?}]}  — 2–4 side-by-side metrics",
  "- row {label, value?, caption?, status?, statusTone?, icon?: 1–2 chars, chevron?: bool}  — list item / key-value line",
  "- list {items:[row fields...], chevron?: bool}  — several rows with dividers (cheaper than many rows)",
  "- badge {text, tone}",
  "- progress_ring {percent: 0–100, label?, caption?, center?}  — partial ring, keeps the real percentage",
  "- progress_bar {percent, label?, valueText?, caption?}",
  "- button {label, variant: primary|secondary|text}   - buttons {items:[{label, variant}], layout?: vertical|horizontal}",
  "- input {label, value?, placeholder?, helper?, error?, dropdown?: bool}   - otp {length, value?}   - checkbox {label, checked}",
  "- tabs {items:[...], active: index}   - chips {items:[...], active?}   - bottom_nav {items:[...], active}",
  "- banner {title?, body?, tone: info|success|warning|danger, action?}   - steps {items:[...], current: index}",
  "- image {label, height?}  — placeholder only, never invent assets",
  "- skeleton {lines?: 1–6, height?, shape?: \"circle\"}  — text-free loading placeholder (lines, or one block when height ≥ 40); shape circle = simple empty-state art",
  "- divider {}",
  "- card {title?, subtitle?, badge?: {text, tone}, blocks:[...]}  — a card inside a plain section (cards do not nest)",
  "- component {componentId, name, instanceProperties?, height?}  — a REAL design-system component; componentId must be an exact id from canvas.components; prefer this for buttons, inputs, tabs, nav, list items when the file has them",
  "- custom {node: native FRAME/TEXT/RECTANGLE/ELLIPSE tree with type,name,width,height,color,...}  — escape hatch ONLY for something no block can express; keep it small",
  "tone values: success|warning|danger|info|neutral. Budget: about 15–35 blocks, max 105 native layers after rendering.",
  "Copy every meaningful source string (labels, amounts, dates, statuses, actions) into block fields exactly as written. Put content in the block that matches its meaning (amount → stat or row value, status → badge/status, % paid ring → progress_ring).",
].join("\n");

export const BLOCK_SPEC_EXAMPLE = JSON.stringify({
  summary: "Clearer loan overview with the paid ring, dues and actions grouped.",
  frame: { name: "Manage loans · variation" },
  theme: { background: "#F6F7F9", primary: "#0B5FFF" },
  sections: [
    { name: "Header", surface: "plain", blocks: [{ type: "app_bar", title: "Manage loans", back: true }] },
    { name: "Loan summary", surface: "card", title: "Personal loan", badge: { text: "Current", tone: "success" }, blocks: [
      { type: "progress_ring", percent: 60, label: "60% paid", caption: "₹1,20,000 of ₹2,00,000" },
      { type: "list", items: [{ label: "Next EMI", value: "₹8,450", caption: "Due 05 Dec" }, { label: "Loan ID", value: "PL12345678" }] },
    ] },
    { name: "Actions", surface: "plain", blocks: [{ type: "buttons", items: [{ label: "Pay EMI", variant: "primary" }, { label: "View statement", variant: "secondary" }] }] },
  ],
  learningCandidate: null,
});
