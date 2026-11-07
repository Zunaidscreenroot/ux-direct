/**
 * Deterministic UI hygiene check ("design lint") on a native Figma read-back.
 *
 * No model is involved: every finding is computed from layer properties, so the
 * same selection always gets the same report. It covers the consistency checks a
 * design reviewer does by hand: auto layout, padding/spacing grid and consistency,
 * repeated-item drift, layer naming, hidden/empty layers, typography and colour
 * sprawl, style/variable usage, touch targets, text contrast and small text.
 */

export type HygieneSeverity = "high" | "medium" | "low";

export type HygieneIssue = {
  rule: string;
  severity: HygieneSeverity;
  issue: string;
  evidence: string;
  fix: string;
  nodeIds: string[];
};

export type HygieneReport = {
  score: number;
  issues: HygieneIssue[];
  stats: {
    nodes: number;
    frames: number;
    autoLayoutFrames: number;
    textNodes: number;
    fontSizes: number[];
    fontFamilies: string[];
    paddingValues: number[];
    spacingValues: number[];
    colors: number;
    truncated: boolean;
  };
};

type Node = Record<string, unknown>;
type Visit = { node: Node; parent: Node | null; ancestors: Node[] };

const CONTAINER_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"]);
const GENERIC_NAME = /^(frame|rectangle|group|ellipse|vector|text|line|polygon|star|union|subtract|intersect|exclude|image|component|instance|section)(\s+\d+)?$/i;
const INTERACTIVE_NAME = /\b(button|btn|cta|icon[ -]?button|tab|chip|toggle|switch|checkbox|radio|link|close|back|menu|fab)\b/i;
const MIN_TOUCH = 44;
const MAX_ISSUES = 25;

function rec(value: unknown): Node | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Node : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function children(node: Node): Node[] {
  return Array.isArray(node.children) ? node.children.map(rec).filter((child): child is Node => !!child) : [];
}
function label(node: Node): string {
  return '"' + str(node.name).slice(0, 40) + '"';
}
function examples(nodes: Node[], max = 4): string {
  const names = [...new Set(nodes.map((node) => label(node)))];
  return names.slice(0, max).join(", ") + (names.length > max ? " +" + (names.length - max) + " more" : "");
}
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG 2.x contrast ratio between two hex colours. */
export function contrastRatio(foreground: string, background: string): number | null {
  const a = hexToRgb(foreground);
  const b = hexToRgb(background);
  if (!a || !b) return null;
  const luminance = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when children read as a single row or column (no overlap along one axis). */
function looksStacked(items: Node[]): boolean {
  const boxes = items
    .map((node) => ({ x: num(node.x), y: num(node.y), w: num(node.width), h: num(node.height) }))
    .filter((box): box is { x: number; y: number; w: number; h: number } => box.x !== null && box.y !== null && box.w !== null && box.h !== null);
  if (boxes.length < 2) return false;
  const disjoint = (start: (b: typeof boxes[number]) => number, size: (b: typeof boxes[number]) => number) => {
    const sorted = [...boxes].sort((a, b) => start(a) - start(b));
    return sorted.every((box, index) => index === 0 || start(box) >= start(sorted[index - 1]) + size(sorted[index - 1]) - 1);
  };
  return disjoint((b) => b.y, (b) => b.h) || disjoint((b) => b.x, (b) => b.w);
}

export function runHygieneCheck(canvas: unknown, options: { paintStyles?: number; textStyles?: number; variables?: number } = {}): HygieneReport {
  const root = rec(canvas);
  const roots = root && Array.isArray(root.nodes) ? root.nodes.map(rec).filter((node): node is Node => !!node) : [];
  const visits: Visit[] = [];
  const walk = (node: Node, parent: Node | null, ancestors: Node[]) => {
    visits.push({ node, parent, ancestors });
    for (const child of children(node)) walk(child, node, [node, ...ancestors]);
  };
  roots.forEach((node) => walk(node, null, []));

  const issues: HygieneIssue[] = [];
  const add = (issue: HygieneIssue) => issues.push({ ...issue, nodeIds: issue.nodeIds.slice(0, 12) });
  const visible = visits.filter((visit) => visit.node.visible !== false && !visit.ancestors.some((a) => a.visible === false));
  const isAutoLayout = (node: Node) => str(node.layoutMode) === "HORIZONTAL" || str(node.layoutMode) === "VERTICAL";
  const insideInstance = (visit: Visit) => visit.ancestors.some((a) => a.type === "INSTANCE");
  const owned = visible.filter((visit) => !insideInstance(visit));

  // 1. Stacks built without auto layout.
  const manualStacks = owned.filter(({ node }) => {
    if (!CONTAINER_TYPES.has(str(node.type)) || isAutoLayout(node)) return false;
    const kids = children(node).filter((child) => child.visible !== false && child.layoutPositioning !== "ABSOLUTE");
    return kids.length >= 2 && looksStacked(kids);
  }).map((visit) => visit.node);
  if (manualStacks.length) add({
    rule: "auto-layout", severity: "medium",
    issue: manualStacks.length + " container(s) stack their children by hand instead of using auto layout.",
    evidence: examples(manualStacks),
    fix: "Apply auto layout (vertical or horizontal) so spacing stays consistent and content can grow. Ask UX Direct: \"add auto layout to " + str(manualStacks[0].name).slice(0, 30) + "\".",
    nodeIds: manualStacks.map((node) => str(node.id)),
  });
  const groups = owned.filter(({ node }) => node.type === "GROUP" && children(node).length >= 2).map((visit) => visit.node);
  if (groups.length) add({
    rule: "groups", severity: "low",
    issue: groups.length + " group(s) hold layout content; groups cannot carry padding, spacing or resizing rules.",
    evidence: examples(groups),
    fix: "Convert layout groups to auto-layout frames (Frame selection, then Shift+A).",
    nodeIds: groups.map((node) => str(node.id)),
  });

  // 2. Padding and spacing on the 4px grid, symmetric, and from a small set of values.
  const autoFrames = owned.map((visit) => visit.node).filter(isAutoLayout);
  const paddingValues = new Map<number, Node[]>();
  const spacingValues = new Map<number, Node[]>();
  const offGrid: Node[] = [];
  const asymmetric: Node[] = [];
  for (const node of autoFrames) {
    const paddings = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"].map((key) => num(node[key]));
    const spacing = num(node.itemSpacing);
    for (const value of paddings) if (value !== null && value > 0) paddingValues.set(round(value), [...(paddingValues.get(round(value)) || []), node]);
    if (spacing !== null && spacing > 0 && str(node.primaryAxisAlignItems) !== "SPACE_BETWEEN") {
      spacingValues.set(round(spacing), [...(spacingValues.get(round(spacing)) || []), node]);
    }
    const values = [...paddings, spacing].filter((value): value is number => value !== null && value > 0);
    if (values.some((value) => value !== 2 && Math.abs(value % 4) > 0.01)) offGrid.push(node);
    const [left, right] = paddings;
    if (left !== null && right !== null && (left > 0 || right > 0) && Math.abs(left - right) > 0.5) asymmetric.push(node);
  }
  if (offGrid.length) add({
    rule: "spacing-grid", severity: "low",
    issue: offGrid.length + " auto-layout frame(s) use padding or gaps off the 4px grid.",
    evidence: offGrid.slice(0, 4).map((node) => label(node) + " (" + ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing"]
      .map((key) => num(node[key])).filter((v) => v !== null).join("/") + ")").join(", "),
    fix: "Round padding and gaps to 4px steps (4, 8, 12, 16, 24, 32).",
    nodeIds: offGrid.map((node) => str(node.id)),
  });
  if (asymmetric.length) add({
    rule: "padding-symmetry", severity: "low",
    issue: asymmetric.length + " frame(s) have different left and right padding.",
    evidence: asymmetric.slice(0, 4).map((node) => label(node) + " L" + num(node.paddingLeft) + "/R" + num(node.paddingRight)).join(", "),
    fix: "Use equal horizontal padding unless the asymmetry is intentional.",
    nodeIds: asymmetric.map((node) => str(node.id)),
  });
  if (paddingValues.size > 5) add({
    rule: "padding-scale", severity: "medium",
    issue: paddingValues.size + " different padding values are used; the layout has no consistent spacing scale.",
    evidence: [...paddingValues.keys()].sort((a, b) => a - b).join(", ") + " px",
    fix: "Standardise on 3–4 spacing tokens (for example 8/16/24) and bind them as spacing variables.",
    nodeIds: [],
  });
  if (spacingValues.size > 5) add({
    rule: "gap-scale", severity: "medium",
    issue: spacingValues.size + " different auto-layout gap values are used.",
    evidence: [...spacingValues.keys()].sort((a, b) => a - b).join(", ") + " px",
    fix: "Reduce gaps to a small scale (for example 4/8/12/16/24).",
    nodeIds: [],
  });

  // 3. Repeated items (same name and type under one parent) that drifted apart.
  const drift: string[] = [];
  const driftIds: string[] = [];
  // Instances that differ usually differ by variant or content: that is fixed in the component,
  // not by overriding padding per instance, so they get their own low-severity, manual finding.
  const instanceDrift: string[] = [];
  const instanceDriftIds: string[] = [];
  for (const { node } of owned) {
    const kids = children(node);
    const byName = new Map<string, Node[]>();
    for (const kid of kids) {
      const key = str(kid.type) + "|" + str(kid.name);
      if (!CONTAINER_TYPES.has(str(kid.type)) && kid.type !== "INSTANCE") continue;
      byName.set(key, [...(byName.get(key) || []), kid]);
    }
    for (const siblings of byName.values()) {
      if (siblings.length < 2) continue;
      const signature = (item: Node) => ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "cornerRadius", "height"]
        .map((key) => num(item[key]) ?? "-").join("/");
      const distinct = new Set(siblings.map(signature));
      if (distinct.size > 1) {
        const instances = siblings[0].type === "INSTANCE";
        (instances ? instanceDrift : drift).push(label(siblings[0]) + " ×" + siblings.length);
        (instances ? instanceDriftIds : driftIds).push(...siblings.map((item) => str(item.id)));
      }
    }
  }
  if (drift.length) add({
    rule: "repeated-item-drift", severity: "medium",
    issue: "Repeated items with the same name have different padding, gap, radius or height.",
    evidence: drift.slice(0, 4).join(", "),
    fix: "Say **fix hygiene** to give them the group's most common padding, gap and radius, or make them instances of one component.",
    nodeIds: driftIds,
  });
  if (instanceDrift.length) add({
    rule: "repeated-instance-variants", severity: "low",
    issue: "Instances of the same component differ in padding, layout or height (different variants or content). Not auto-fixed: per-instance overrides would hide the difference.",
    evidence: instanceDrift.slice(0, 4).join(", "),
    fix: "Check it is intended; otherwise pick one variant or fix the spacing in the main component.",
    nodeIds: instanceDriftIds,
  });

  // 4. Layer naming, hidden and empty layers.
  const generic = visits.filter((visit) => !insideInstance(visit) && GENERIC_NAME.test(str(visit.node.name).trim()) && visit.node.type !== "TEXT")
    .map((visit) => visit.node);
  if (generic.length) add({
    rule: "layer-names", severity: "low",
    issue: generic.length + " layer(s) still have default names.",
    evidence: examples(generic, 6),
    fix: "Rename layers by purpose (Header, Price row, Primary CTA). Ask UX Direct: \"rename layers\".",
    nodeIds: generic.map((node) => str(node.id)),
  });
  const hidden = visits.filter((visit) => visit.node.visible === false && !visit.ancestors.some((a) => a.visible === false) && !insideInstance(visit))
    .map((visit) => visit.node);
  if (hidden.length) add({
    rule: "hidden-layers", severity: "low",
    issue: hidden.length + " hidden layer(s) are left in the design.",
    evidence: examples(hidden),
    fix: "Delete hidden leftovers, or move intentional states into component variants.",
    nodeIds: hidden.map((node) => str(node.id)),
  });
  const empty = owned.filter(({ node }) => node.type === "FRAME" && num(node.childCount) === 0 &&
    !(Array.isArray(node.fillColors) && node.fillColors.length) && node.imageFill !== true && !(Array.isArray(node.strokeColors) && node.strokeColors.length))
    .map((visit) => visit.node);
  if (empty.length) add({
    rule: "empty-frames", severity: "low",
    issue: empty.length + " empty, invisible frame(s).",
    evidence: examples(empty),
    fix: "Remove empty frames or give them a purpose.",
    nodeIds: empty.map((node) => str(node.id)),
  });

  // 5. Typography.
  const texts = visible.filter((visit) => visit.node.type === "TEXT");
  const fontSizes = [...new Set(texts.map((visit) => num(visit.node.fontSize)).filter((v): v is number => v !== null).map(round))].sort((a, b) => a - b);
  const fontFamilies = [...new Set(texts.map((visit) => str(visit.node.fontFamily)).filter(Boolean))];
  if (fontSizes.length > 6) add({
    rule: "type-scale", severity: "medium",
    issue: fontSizes.length + " different font sizes are used.",
    evidence: fontSizes.join(", ") + " px",
    fix: "Collapse to a type scale of about 5 sizes and apply text styles.",
    nodeIds: [],
  });
  if (fontFamilies.length > 2) add({
    rule: "font-families", severity: "medium",
    issue: fontFamilies.length + " font families are mixed.",
    evidence: fontFamilies.slice(0, 6).join(", "),
    fix: "Use one family (two at most: display + text).",
    nodeIds: [],
  });
  const ownedTexts = texts.filter((visit) => !insideInstance(visit));
  const unstyledText = ownedTexts.filter((visit) => visit.node.textStyled !== true).map((visit) => visit.node);
  if ((options.textStyles || 0) > 0 && unstyledText.length) add({
    rule: "text-styles", severity: "medium",
    issue: unstyledText.length + " of " + ownedTexts.length + " text layer(s) do not use the file's text styles.",
    evidence: examples(unstyledText),
    fix: "Apply the matching text style so typography updates from one place.",
    nodeIds: unstyledText.map((node) => str(node.id)),
  });
  const smallText = texts.filter((visit) => { const size = num(visit.node.fontSize); return size !== null && size < 12; }).map((visit) => visit.node);
  if (smallText.length) add({
    rule: "small-text", severity: "low",
    issue: smallText.length + " text layer(s) are smaller than 12px.",
    evidence: smallText.slice(0, 4).map((node) => label(node) + " " + num(node.fontSize) + "px").join(", "),
    fix: "Use at least 12px (14px+ for body text on mobile).",
    nodeIds: smallText.map((node) => str(node.id)),
  });

  // 6. Colour usage.
  const colors = new Set<string>();
  const hardcoded: Node[] = [];
  for (const { node } of owned) {
    const fills = Array.isArray(node.fillColors) ? node.fillColors.filter((c): c is string => typeof c === "string") : [];
    fills.forEach((color) => colors.add(color.toUpperCase()));
    if (fills.length && node.fillStyled !== true && node.variableBound !== true) hardcoded.push(node);
  }
  if (((options.paintStyles || 0) > 0 || (options.variables || 0) > 0) && hardcoded.length) add({
    rule: "color-tokens", severity: "medium",
    issue: hardcoded.length + " layer(s) use hard-coded colours although the file has colour styles or variables.",
    evidence: examples(hardcoded),
    fix: "Bind fills to colour variables or paint styles so themes and dark mode work.",
    nodeIds: hardcoded.map((node) => str(node.id)),
  });
  if (colors.size > 12) add({
    rule: "color-sprawl", severity: "low",
    issue: colors.size + " distinct fill colours are used.",
    evidence: [...colors].slice(0, 10).join(", "),
    fix: "Reduce to a defined palette (neutrals, primary, semantic colours).",
    nodeIds: [],
  });
  const radii = new Set(owned.map((visit) => num(visit.node.cornerRadius)).filter((v): v is number => v !== null && v > 0).map(round));
  if (radii.size > 4) add({
    rule: "radius-scale", severity: "low",
    issue: radii.size + " different corner radii are used.",
    evidence: [...radii].sort((a, b) => a - b).join(", ") + " px",
    fix: "Use 2–3 radius tokens (for example 8 for inputs, 12 for cards, full for pills).",
    nodeIds: [],
  });

  // 7. Accessibility: touch targets and contrast.
  const smallTargets = owned.filter(({ node }) => {
    if (node.type === "TEXT" || !INTERACTIVE_NAME.test(str(node.name))) return false;
    const w = num(node.width);
    const h = num(node.height);
    return w !== null && h !== null && (w < MIN_TOUCH || h < MIN_TOUCH);
  }).map((visit) => visit.node);
  if (smallTargets.length) add({
    rule: "touch-target", severity: "medium",
    issue: smallTargets.length + " tappable element(s) are smaller than 44×44.",
    evidence: smallTargets.slice(0, 4).map((node) => label(node) + " " + Math.round(num(node.width)!) + "×" + Math.round(num(node.height)!)).join(", "),
    fix: "Give tappable elements a hit area of at least 44×44 (padding or a transparent container).",
    nodeIds: smallTargets.map((node) => str(node.id)),
  });
  const lowContrast: Array<{ node: Node; ratio: number; required: number }> = [];
  for (const visit of texts) {
    const fg = Array.isArray(visit.node.fillColors) ? str(visit.node.fillColors[0]) : "";
    const bgNode = visit.ancestors.find((a) => Array.isArray(a.fillColors) && a.fillColors.length && a.imageFill !== true);
    const bg = bgNode ? str((bgNode.fillColors as unknown[])[0]) : "";
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    const size = num(visit.node.fontSize) || 14;
    const bold = /bold|semi|heavy|black/i.test(str(visit.node.fontStyle));
    const required = size >= 24 || (size >= 18.5 && bold) ? 3 : 4.5;
    if (ratio !== null && ratio < required) lowContrast.push({ node: visit.node, ratio, required });
  }
  if (lowContrast.length) {
    const worst = lowContrast.some((item) => item.ratio < 3);
    add({
      rule: "contrast", severity: worst ? "high" : "medium",
      issue: lowContrast.length + " text layer(s) fail WCAG AA contrast against their background.",
      evidence: lowContrast.slice(0, 4).map((item) => label(item.node) + " " + item.ratio.toFixed(2) + ":1 (needs " + item.required + ":1)").join(", "),
      fix: "Darken the text or lighten the background until the ratio meets 4.5:1 (3:1 for large text).",
      nodeIds: lowContrast.map((item) => str(item.node.id)),
    });
  }

  const order: Record<HygieneSeverity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const penalty = issues.reduce((total, issue) => total + (issue.severity === "high" ? 15 : issue.severity === "medium" ? 7 : 3), 0);
  return {
    score: Math.max(0, 100 - penalty),
    issues: issues.slice(0, MAX_ISSUES),
    stats: {
      nodes: visits.length,
      frames: visits.filter((visit) => CONTAINER_TYPES.has(str(visit.node.type))).length,
      autoLayoutFrames: autoFrames.length,
      textNodes: texts.length,
      fontSizes,
      fontFamilies,
      paddingValues: [...paddingValues.keys()].sort((a, b) => a - b),
      spacingValues: [...spacingValues.keys()].sort((a, b) => a - b),
      colors: colors.size,
      truncated: root?.truncated === true,
    },
  };
}

export function formatHygieneReport(report: HygieneReport): string {
  const lines = ["**UI hygiene score: " + report.score + "/100** · " + report.stats.nodes + " layers checked, " +
    report.stats.autoLayoutFrames + "/" + report.stats.frames + " frames use auto layout."];
  if (!report.issues.length) lines.push("No hygiene issues found.");
  for (const issue of report.issues) {
    lines.push("- **" + issue.severity.toUpperCase() + "** " + issue.issue + " " + issue.evidence + ". Fix: " + issue.fix);
  }
  if (report.stats.truncated) lines.push("Note: the selection was larger than the read limit, so some layers were not checked.");
  const fixable = new Set(report.issues.map((issue) => issue.rule));
  const offers: string[] = [];
  if (fixable.has("spacing-grid") || fixable.has("padding-symmetry") || fixable.has("color-tokens") || fixable.has("text-styles")) offers.push("**fix hygiene** (4px grid, padding, colour + text tokens)");
  if (fixable.has("contrast") || fixable.has("small-text") || fixable.has("touch-target")) offers.push("**fix accessibility** (contrast, 12px text, 44px targets)");
  if (fixable.has("auto-layout")) offers.push("**fix auto layout**");
  if (offers.length) lines.push("Auto-fix without a model: say " + offers.join(", ") + ", or **fix all**.");
  return lines.join("\n");
}
