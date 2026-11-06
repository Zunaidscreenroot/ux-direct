/**
 * Source fidelity for block-rendered variations.
 *
 * Block specs describe text content only, so logos, icons, chevrons, charts and image
 * layers in the source were silently dropped (Test #1, "Manage Loans": brand logos, donut
 * progress, chevrons, warning and info icons all lost). This pass runs after the renderer
 * and puts every source graphic back as a CLONE of the original node, anchored next to the
 * nearest unique source text that also exists in the output. It also turns source buttons
 * that the model downgraded to plain text links back into filled buttons.
 *
 * Everything here is deterministic: no model call, no invented assets.
 */
import type { BlockTheme, NativeNode } from "./block-spec";

type Rec = Record<string, unknown>;
type Rect = { x: number; y: number; w: number; h: number };
type SrcNode = { raw: Rec; id: string; type: string; name: string; rect: Rect; parent: SrcNode | null; children: SrcNode[]; text: string };

const SHAPE_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE"]);
const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT"]);
/** Plan depth at which a node may still be a child (createPlanChildren rejects deeper). */
const MAX_PLAN_DEPTH = 4;
export const SOURCE_GRAPHIC_BUDGET = 30;

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildSourceTree(raw: Rec, parent: SrcNode | null, offsetX: number, offsetY: number, isRoot: boolean): SrcNode | null {
  if (raw.visible === false || typeof raw.type !== "string") return null;
  const x = num(raw.x) ?? 0, y = num(raw.y) ?? 0;
  // Root carries page coordinates; children are parent-relative in read-canvas output.
  const absX = isRoot ? 0 : offsetX + x;
  const absY = isRoot ? 0 : offsetY + y;
  const node: SrcNode = {
    raw, id: typeof raw.id === "string" ? raw.id : "", type: raw.type, name: typeof raw.name === "string" ? raw.name : raw.type,
    rect: { x: absX, y: absY, w: num(raw.width) ?? 0, h: num(raw.height) ?? 0 }, parent, children: [],
    text: raw.type === "TEXT" && typeof raw.text === "string" ? raw.text.trim() : "",
  };
  for (const child of Array.isArray(raw.children) ? raw.children : []) {
    const rec = asRec(child);
    const built = rec ? buildSourceTree(rec, node, absX, absY, false) : null;
    if (built) node.children.push(built);
  }
  return node;
}

function descendants(node: SrcNode, out: SrcNode[] = []): SrcNode[] {
  for (const child of node.children) { out.push(child); descendants(child, out); }
  return out;
}

function isGraphicLeaf(node: SrcNode): boolean {
  if (SHAPE_TYPES.has(node.type)) return true;
  if (node.raw.imageFill === true) return true;
  return false;
}

/**
 * A graphic is the highest node that reads as one visual unit: a vector/shape/image, a small
 * icon instance, a small frame/group made only of shapes (logo, icon), or a small ring cluster
 * (ellipses plus at most 3 short labels).
 */
function classify(node: SrcNode, headerId: string | null): "graphic" | "skip" | "recurse" {
  if (node.type === "TEXT") return "skip";
  if (node.id && node.id === headerId) return "skip";
  const size = Math.max(node.rect.w, node.rect.h);
  if (isGraphicLeaf(node) && !node.children.length) {
    // Full-width background shapes and hairline dividers are layout, not content.
    if (node.type !== "ELLIPSE" && node.raw.imageFill !== true && size > 200) return "skip";
    if (node.rect.w < 2 || node.rect.h < 2) return "skip";
    return "graphic";
  }
  if (node.raw.imageFill === true && size <= 240) return "graphic";
  if (!CONTAINER_TYPES.has(node.type)) return node.children.length ? "recurse" : "skip";
  const all = descendants(node);
  const texts = all.filter((d) => d.type === "TEXT");
  const shapes = all.filter(isGraphicLeaf);
  if (node.type === "INSTANCE" && size <= 64 && texts.length === 0) return "graphic";
  if (size <= 160 && shapes.length > 0 && texts.length === 0) return "graphic";
  const ellipses = shapes.filter((s) => s.type === "ELLIPSE").length;
  if (size <= 160 && ellipses >= 2 && texts.length <= 3 && texts.every((t) => t.text.length <= 24)) return "graphic";
  if (node.type === "INSTANCE" && !all.length) return "skip";
  return "recurse";
}

function collectGraphics(node: SrcNode, headerId: string | null, out: SrcNode[]) {
  for (const child of node.children) {
    const kind = classify(child, headerId);
    if (kind === "graphic") { if (child.id) out.push(child); }
    else if (kind === "recurse") collectGraphics(child, headerId, out);
  }
}

type OutRef = { node: NativeNode; parent: NativeNode | null; depth: number; ancestors: NativeNode[] };

function indexOutput(elements: NativeNode[]): OutRef[] {
  const refs: OutRef[] = [];
  const visit = (nodes: NativeNode[], parent: NativeNode | null, depth: number, ancestors: NativeNode[]) => {
    for (const node of nodes) {
      refs.push({ node, parent, depth, ancestors });
      if (node.children?.length) visit(node.children, node, depth + 1, [...ancestors, node]);
    }
  };
  visit(elements, null, 0, []);
  return refs;
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function isCardLike(node: NativeNode): boolean {
  return node.type === "FRAME" && (typeof node.color === "string" || typeof node.strokeColor === "string");
}

function siblingsOf(ref: OutRef, elements: NativeNode[]): NativeNode[] {
  return ref.parent ? ref.parent.children ?? [] : elements;
}

function recomputeHeights(nodes: NativeNode[]) {
  for (const node of nodes) {
    if (!node.children?.length) continue;
    recomputeHeights(node.children);
    const flow = node.children.filter((c) => c.layoutPositioning !== "ABSOLUTE");
    const pt = num(node.paddingTop) ?? 0, pb = num(node.paddingBottom) ?? 0, gap = num(node.itemSpacing) ?? 0;
    if (node.layoutMode === "VERTICAL" && node.primaryAxisSizingMode === "AUTO") {
      node.height = Math.max(1, Math.ceil(pt + pb + flow.reduce((s, c) => s + c.height, 0) + Math.max(0, flow.length - 1) * gap));
    } else if (node.layoutMode === "HORIZONTAL" && node.counterAxisSizingMode === "AUTO") {
      node.height = Math.max(1, Math.ceil(pt + pb + flow.reduce((m, c) => Math.max(m, c.height), 0)));
    }
  }
}

export type SourceFidelityResult = { clones: number; replacedRings: number; restoredButtons: number; unplaced: string[] };

/**
 * Mutates `elements` in place. `canvas` is the raw source read-back (first node = source
 * frame). Returns what was restored so the route can report it.
 */
export function restoreSourceFidelity(elements: NativeNode[], canvas: Rec, theme: BlockTheme, options: { budget?: number; headerComponentId?: string | null } = {}): SourceFidelityResult {
  const result: SourceFidelityResult = { clones: 0, replacedRings: 0, restoredButtons: 0, unplaced: [] };
  const rootRaw = asRec(Array.isArray(canvas.nodes) ? canvas.nodes[0] : null);
  if (!rootRaw) return result;
  const root = buildSourceTree(rootRaw, null, 0, 0, true);
  if (!root) return result;
  const firstChild = root.children[0];
  const headerId = firstChild && firstChild.type === "INSTANCE" && options.headerComponentId &&
    firstChild.raw.mainComponentId === options.headerComponentId ? firstChild.id : null;

  restoreButtons(elements, root, theme, result);

  const graphics: SrcNode[] = [];
  collectGraphics(root, headerId, graphics);
  // Charts, logos and images matter more than small glyphs when the budget is tight.
  const weight = (g: SrcNode) => (descendants(g).some((d) => d.type === "ELLIPSE") || g.type === "ELLIPSE" ? 0 : g.raw.imageFill === true ? 1 : Math.max(g.rect.w, g.rect.h) >= 28 ? 2 : 3);
  graphics.sort((a, b) => weight(a) - weight(b));
  const budget = Math.max(0, options.budget ?? SOURCE_GRAPHIC_BUDGET);

  const allTexts = descendants(root).filter((d) => d.type === "TEXT" && d.text);
  const sourceCount = new Map<string, number>();
  for (const t of allTexts) sourceCount.set(norm(t.text), (sourceCount.get(norm(t.text)) || 0) + 1);
  const usedSourceIds = new Set<string>();
  (function markUsed(nodes: NativeNode[]) {
    for (const n of nodes) {
      if (n.type === "CLONE" && typeof n.sourceNodeId === "string") usedSourceIds.add(n.sourceNodeId);
      if (n.children) markUsed(n.children);
    }
  })(elements);

  for (const graphic of graphics) {
    if (result.clones >= budget) { result.unplaced.push(graphic.name); continue; }
    if (usedSourceIds.has(graphic.id)) continue;
    // A source back arrow (small, top-left) replaces the renderer's "←" glyph.
    if (graphic.rect.y < 120 && graphic.rect.x < 48 && Math.max(graphic.rect.w, graphic.rect.h) <= 48) {
      const back = indexOutput(elements).find((r) => r.node.type === "TEXT" && r.node.text === "←" && String(r.node.name).startsWith("Back"));
      if (back) {
        const host = back.parent ? back.parent.children! : elements;
        host.splice(host.indexOf(back.node), 1, {
          type: "CLONE", name: graphic.name.slice(0, 80) || "Back", sourceNodeId: graphic.id, x: 0, y: 0,
          width: Math.max(1, Math.round(graphic.rect.w)), height: Math.max(1, Math.round(graphic.rect.h)),
          layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
        });
        result.clones += 1;
        usedSourceIds.add(graphic.id);
        continue;
      }
    }
    const own = new Set(descendants(graphic).map((d) => d.id));
    const ownTexts = descendants(graphic).filter((d) => d.type === "TEXT" && d.text).map((d) => norm(d.text));
    const refs = indexOutput(elements);
    const outTextCount = new Map<string, number>();
    for (const r of refs) if (r.node.type === "TEXT" && typeof r.node.text === "string") {
      const k = norm(r.node.text); outTextCount.set(k, (outTextCount.get(k) || 0) + 1);
    }
    // Walk up from the graphic until an ancestor holds a text that is unique in both trees.
    let anchor: SrcNode | null = null;
    for (let scope = graphic.parent, hops = 0; scope && hops < 5 && !anchor; scope = scope.parent, hops += 1) {
      const candidates = descendants(scope).filter((d) => d.type === "TEXT" && d.text && !own.has(d.id) &&
        sourceCount.get(norm(d.text)) === 1 && outTextCount.get(norm(d.text)) === 1);
      const cx = graphic.rect.x + graphic.rect.w / 2, cy = graphic.rect.y + graphic.rect.h / 2;
      candidates.sort((a, b) => Math.hypot(a.rect.x + a.rect.w / 2 - cx, a.rect.y + a.rect.h / 2 - cy) -
        Math.hypot(b.rect.x + b.rect.w / 2 - cx, b.rect.y + b.rect.h / 2 - cy));
      anchor = candidates[0] ?? null;
    }
    if (!anchor) { result.unplaced.push(graphic.name); continue; }
    const anchorRef = refs.find((r) => r.node.type === "TEXT" && typeof r.node.text === "string" && norm(r.node.text) === norm(anchor!.text));
    if (!anchorRef) { result.unplaced.push(graphic.name); continue; }

    const clone: NativeNode = {
      type: "CLONE", name: graphic.name.slice(0, 80) || "Source graphic", sourceNodeId: graphic.id,
      x: 0, y: 0, width: Math.max(1, Math.round(graphic.rect.w)), height: Math.max(1, Math.round(graphic.rect.h)),
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    };
    const card = [...anchorRef.ancestors].reverse().find(isCardLike) ?? anchorRef.ancestors[0] ?? null;

    // A generated ring next to the anchor is replaced by the real source chart.
    const ringLike = graphic.type === "ELLIPSE" || descendants(graphic).some((d) => d.type === "ELLIPSE");
    if (ringLike && card) {
      const ringRef = indexOutput(card.children ?? []).find((r) => r.node.type === "FRAME" && r.node.name === "Progress ring");
      if (ringRef) {
        const host = ringRef.parent ? ringRef.parent.children! : card.children!;
        host.splice(host.indexOf(ringRef.node), 1, clone);
        result.replacedRings += 1;
        result.clones += 1;
        usedSourceIds.add(graphic.id);
        dropDuplicateTexts(card, ownTexts, clone);
        continue;
      }
    }

    // Wrapped nodes may not shrink below the clone; scale wide graphics into the slot.
    const parent = anchorRef.parent;
    const slot = parent ? Math.max(24, parent.width - (num(parent.paddingLeft) ?? 0) - (num(parent.paddingRight) ?? 0)) : 9999;
    if (clone.width > slot) {
      const ratio = slot / clone.width;
      clone.width = Math.round(slot); clone.height = Math.max(1, Math.round(clone.height * ratio));
    }
    const g = graphic.rect, a = anchor.rect;
    const sideBySide = overlap1d(g.y, g.y + g.h, a.y, a.y + a.h) > Math.min(g.h, a.h) * 0.3;
    const before = sideBySide ? g.x + g.w / 2 < a.x + a.w / 2 : g.y + g.h / 2 < a.y + a.h / 2;

    let target: OutRef = anchorRef;
    // Text inside a free-positioned frame (generated ring) is not an Auto Layout slot.
    if (parent && parent.layoutMode !== "VERTICAL" && parent.layoutMode !== "HORIZONTAL") {
      const up = refs.find((r) => r.node === parent);
      if (!up) { result.unplaced.push(graphic.name); continue; }
      target = up;
    }
    const host = target.parent;
    const siblings = siblingsOf(target, elements);
    const index = siblings.indexOf(target.node);
    if (index < 0) { result.unplaced.push(graphic.name); continue; }
    if (host && host.layoutMode === "VERTICAL" && sideBySide && target.depth + 1 <= MAX_PLAN_DEPTH) {
      // Graphic sat beside the text: wrap both in a horizontal row.
      const textNode = target.node;
      const gap = 8;
      textNode.width = Math.max(24, textNode.width - clone.width - gap);
      textNode.layoutSizingHorizontal = "FILL";
      textNode.layoutGrow = 1;
      const row: NativeNode = {
        type: "FRAME", name: (textNode.name || "Row") .slice(0, 70) + " row", x: 0, y: 0,
        width: host.width - (num(host.paddingLeft) ?? 0) - (num(host.paddingRight) ?? 0), height: Math.max(textNode.height, clone.height),
        layoutMode: "HORIZONTAL", itemSpacing: gap, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
        primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER",
        layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", noFill: true,
        children: before ? [clone, textNode] : [textNode, clone],
      };
      siblings.splice(index, 1, row);
    } else {
      siblings.splice(before ? index : index + 1, 0, clone);
    }
    result.clones += 1;
    usedSourceIds.add(graphic.id);
    if (ownTexts.length && card) dropDuplicateTexts(card, ownTexts, clone);
  }
  recomputeHeights(elements);
  return result;
}

/** A cloned chart already carries its labels ("40%", "Paid"); remove generated copies in the same card. */
function dropDuplicateTexts(card: NativeNode, ownTexts: string[], clone: NativeNode) {
  if (!ownTexts.length) return;
  const wanted = new Set(ownTexts);
  const prune = (node: NativeNode) => {
    if (!node.children) return;
    node.children = node.children.filter((child) => child === clone || !(child.type === "TEXT" && typeof child.text === "string" && wanted.has(norm(child.text))));
    for (const child of node.children) prune(child);
    node.children = node.children.filter((child) => child.type !== "FRAME" || child === clone || (child.children?.length ?? 0) > 0 || typeof child.color === "string");
  };
  prune(card);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function sourceButtonLabels(root: SrcNode): Set<string> {
  const labels = new Set<string>();
  for (const node of descendants(root)) {
    if (!CONTAINER_TYPES.has(node.type)) continue;
    const texts = descendants(node).filter((d) => d.type === "TEXT" && d.text);
    if (texts.length !== 1) continue;
    const filled = Array.isArray(node.raw.fillColors) && node.raw.fillColors.length > 0;
    const named = /\b(button|btn|cta)\b/i.test(node.name);
    const shaped = filled && node.rect.h >= 24 && node.rect.h <= 64 && node.rect.w >= 48 && node.rect.w <= 420 && (num(node.raw.cornerRadius) ?? 0) > 0;
    if ((shaped || named) && texts[0].text.length <= 40) labels.add(norm(texts[0].text));
  }
  return labels;
}

function restoreButtons(elements: NativeNode[], root: SrcNode, theme: BlockTheme, result: SourceFidelityResult) {
  const labels = sourceButtonLabels(root);
  if (!labels.size) return;
  for (const ref of indexOutput(elements)) {
    const node = ref.node;
    if (node.type !== "TEXT" || typeof node.text !== "string" || !labels.has(norm(node.text))) continue;
    const parent = ref.parent;
    if (parent && typeof parent.color === "string" && (num(parent.cornerRadius) ?? 0) > 0 && (parent.children?.length ?? 0) === 1) continue; // already a button
    if (parent && /text button/i.test(parent.name) && (parent.children?.length ?? 0) === 1) {
      // The renderer's text-variant button: give it the primary fill back.
      parent.name = node.text.slice(0, 60) + " button";
      parent.color = theme.primaryFill;
      delete parent.noFill;
      parent.cornerRadius = theme.radius;
      parent.height = Math.max(parent.height, 48);
      parent.counterAxisSizingMode = "FIXED"; parent.layoutSizingVertical = "FIXED";
      node.color = theme.onPrimary;
      result.restoredButtons += 1;
      continue;
    }
    if (ref.depth + 1 > MAX_PLAN_DEPTH) continue;
    const siblings = ref.parent ? ref.parent.children! : elements;
    const index = siblings.indexOf(node);
    if (index < 0) continue;
    const inRow = parent?.layoutMode === "HORIZONTAL";
    const labelNode: NativeNode = { ...node, color: theme.onPrimary, textAlignHorizontal: "CENTER", textAutoResize: "WIDTH_AND_HEIGHT", layoutSizingHorizontal: "HUG", layoutGrow: 0 };
    const width = inRow ? Math.ceil(labelNode.width + 32) : node.width;
    const button: NativeNode = {
      type: "FRAME", name: node.text.slice(0, 60) + " button", x: 0, y: 0, width, height: 44,
      layoutMode: "HORIZONTAL", itemSpacing: 8, paddingTop: 10, paddingRight: 16, paddingBottom: 10, paddingLeft: 16,
      primaryAxisSizingMode: inRow ? "AUTO" : "FIXED", counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: inRow ? "HUG" : "FILL", layoutSizingVertical: "FIXED",
      color: theme.primaryFill, cornerRadius: theme.radius,
      children: [labelNode],
    };
    if (typeof node.layoutPositioning === "string") button.layoutPositioning = node.layoutPositioning;
    siblings.splice(index, 1, button);
    result.restoredButtons += 1;
  }
}
