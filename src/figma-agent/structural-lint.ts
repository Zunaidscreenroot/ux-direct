/**
 * Deterministic, model-free quality checks on native Figma read-backs.
 *
 * Two families of checks run on the layer trees the plugin already reads:
 * 1. Layout lint on the output: text/text and text/icon overlap, content
 *    clipped by a clipping ancestor, and collapsed (near-zero size) text.
 * 2. Source-content preservation: every visible source text, numeric value and
 *    graphic category must still exist in the output unless the request asks
 *    for copy changes or removals.
 *
 * Findings use the same {severity, issue, evidence, fix} shape as visual QA so
 * they flow through the existing quality gate and bounded repair loop.
 */

export type LintSeverity = "high" | "medium" | "low";

export type StructuralLintIssue = {
  severity: LintSeverity;
  issue: string;
  evidence: string;
  fix: string;
};

export type ContentCheck = {
  mode: "full" | "numbers-only" | "skipped";
  reason: string;
  sourceTextCount: number;
  missingText: string[];
  missingNumbers: string[];
  /** True when the output read-back was truncated or depth-limited, so absence cannot be proven. */
  partial: boolean;
};

export type StructuralLintResult = {
  passed: boolean;
  issues: StructuralLintIssue[];
  layout: { textNodes: number; overlaps: number; clipped: number; collapsedText: number };
  content: ContentCheck;
};

type Rect = { x: number; y: number; w: number; h: number };

type FlatNode = {
  id: string;
  name: string;
  type: string;
  text: string;
  rect: Rect | null;
  absolute: boolean;
  clips: boolean;
  /** Ids of ancestors that clip content, nearest first, with their rects. */
  clipAncestors: Array<{ id: string; rect: Rect }>;
  parent: FlatNode | null;
  filled: boolean;
  radius: number;
  imageFill: boolean;
};

type CanvasTree = { nodes: FlatNode[]; truncated: boolean; texts: string[] };

const GRAPHIC_TYPES = new Set(["ELLIPSE", "VECTOR", "STAR", "POLYGON", "BOOLEAN_OPERATION", "INSTANCE"]);
const ICON_TYPES = new Set(["VECTOR", "INSTANCE", "BOOLEAN_OPERATION", "STAR", "POLYGON"]);
const ICON_MAX_SIZE = 64;
const MAX_ISSUES = 12;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findRoot(nodes: unknown[], rootId?: string): Record<string, unknown> | null {
  if (!rootId) return record(nodes[0]);
  const stack = [...nodes];
  while (stack.length) {
    const node = record(stack.shift());
    if (!node) continue;
    if (node.id === rootId) return node;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

/** Flatten one root subtree into absolute rects. Hidden subtrees are skipped. */
export function flattenCanvas(canvas: unknown, rootId?: string): CanvasTree {
  const source = record(canvas);
  const list = source && Array.isArray(source.nodes) ? source.nodes : [];
  const root = findRoot(list, rootId);
  const out: FlatNode[] = [];
  const texts: string[] = [];
  let unexpanded = false;
  function walk(value: unknown, parentX: number, parentY: number, isRoot: boolean, clipAncestors: FlatNode["clipAncestors"], parent: FlatNode | null = null) {
    const node = record(value);
    if (!node || typeof node.id !== "string" || typeof node.type !== "string") return;
    if (node.visible === false || num(node.opacity) === 0) return;
    const x = num(node.x), y = num(node.y), w = num(node.width), h = num(node.height);
    const rotated = (num(node.rotation) || 0) !== 0;
    // Top-level read-back nodes carry page coordinates; children are parent-relative.
    const absX = isRoot ? (x ?? 0) : parentX + (x ?? 0);
    const absY = isRoot ? (y ?? 0) : parentY + (y ?? 0);
    const rect = x !== null && y !== null && w !== null && h !== null && !rotated ? { x: absX, y: absY, w, h } : null;
    const text = node.type === "TEXT" && typeof node.text === "string" ? node.text : "";
    if (text.trim()) texts.push(text);
    const props = record(node.componentProperties);
    // An expanded instance shows its real texts; its property values are variant settings
    // ("type 1", "yes"), not copy. Only a collapsed instance needs them as a text proxy.
    const expanded = Array.isArray(node.children) && node.children.length > 0;
    if (props && !expanded) {
      // Variant values like "24" (icon size) or "true" are settings, not visible copy.
      for (const propValue of Object.values(props)) {
        if (typeof propValue === "string" && propValue.trim() && !/^(?:\d+(?:\.\d+)?(?:px)?|true|false|yes|no|on|off|type \d+|variant\s*\d*|default)$/i.test(propValue.trim())) texts.push(propValue);
      }
    }
    const flat: FlatNode = {
      id: node.id,
      name: typeof node.name === "string" ? node.name.slice(0, 60) : node.type,
      type: node.type,
      text,
      rect,
      absolute: node.layoutPositioning === "ABSOLUTE",
      clips: node.clipsContent === true,
      clipAncestors,
      parent,
      filled: Array.isArray(node.fillColors) && node.fillColors.length > 0,
      radius: num(node.cornerRadius) ?? 0,
      imageFill: node.imageFill === true,
    };
    out.push(flat);
    // A depth-limited or collapsed read lists childCount without the children themselves.
    if ((num(node.childCount) || 0) > 0 && !(Array.isArray(node.children) && node.children.length)) unexpanded = true;
    if (Array.isArray(node.children)) {
      const nextClips = flat.clips && rect ? [{ id: flat.id, rect }, ...clipAncestors] : clipAncestors;
      for (const child of node.children) walk(child, absX, absY, false, nextClips, flat);
    }
  }
  if (root) walk(root, 0, 0, true, []);
  return { nodes: out, truncated: source?.truncated === true || unexpanded, texts };
}

function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function label(node: FlatNode): string {
  const text = node.text ? ' "' + node.text.replace(/\s+/g, " ").trim().slice(0, 40) + '"' : "";
  return node.type + " " + node.id + " (" + node.name + ")" + text;
}

const TOLERANCE = 2;

export function lintLayout(tree: CanvasTree): { issues: StructuralLintIssue[]; overlaps: number; clipped: number; collapsedText: number; textNodes: number } {
  const issues: StructuralLintIssue[] = [];
  const texts = tree.nodes.filter(node => node.type === "TEXT" && node.text.trim() && node.rect);
  let collapsedText = 0, overlaps = 0, clipped = 0;

  for (const node of texts) {
    if (node.rect!.w < 2 || node.rect!.h < 2) {
      collapsedText += 1;
      issues.push({
        severity: "high",
        issue: "Text layer has collapsed to near-zero size and is unreadable.",
        evidence: label(node) + " is " + Math.round(node.rect!.w) + "×" + Math.round(node.rect!.h) + "px.",
        fix: "Give the text a FIXED width (or FILL in an Auto Layout parent) with textAutoResize HEIGHT.",
      });
    }
  }

  const readable = texts.filter(node => node.rect!.w >= 2 && node.rect!.h >= 2);
  for (let i = 0; i < readable.length; i++) {
    for (let j = i + 1; j < readable.length; j++) {
      const a = readable[i], b = readable[j];
      const hit = intersection(a.rect!, b.rect!);
      if (!hit || hit.w <= TOLERANCE || hit.h <= TOLERANCE) continue;
      const smaller = Math.min(a.rect!.w * a.rect!.h, b.rect!.w * b.rect!.h);
      if (hit.w * hit.h < smaller * 0.15) continue;
      overlaps += 1;
      issues.push({
        severity: "high",
        issue: "Two text layers overlap each other.",
        evidence: label(a) + " overlaps " + label(b) + " by " + Math.round(hit.w) + "×" + Math.round(hit.h) + "px.",
        fix: "Place both texts in an Auto Layout stack with itemSpacing, or move/resize one so they no longer intersect.",
      });
    }
  }

  const icons = tree.nodes.filter(node => ICON_TYPES.has(node.type) && node.rect &&
    node.rect.w <= ICON_MAX_SIZE && node.rect.h <= ICON_MAX_SIZE);
  for (const text of readable) {
    // Absolute text is usually an intentional badge/label overlay (e.g. a count on a bell icon).
    if (text.absolute) continue;
    for (const icon of icons) {
      const hit = intersection(text.rect!, icon.rect!);
      if (!hit || hit.w <= TOLERANCE || hit.h <= TOLERANCE) continue;
      if (hit.w * hit.h < icon.rect!.w * icon.rect!.h * 0.25) continue;
      overlaps += 1;
      issues.push({
        severity: "medium",
        issue: "An icon overlaps text.",
        evidence: label(icon) + " covers part of " + label(text) + ".",
        fix: "Put the icon and text in a HORIZONTAL Auto Layout row with itemSpacing instead of overlapping positions.",
      });
    }
  }

  for (const node of tree.nodes) {
    if (!node.rect || !node.clipAncestors.length) continue;
    const isText = node.type === "TEXT" && !!node.text.trim();
    const isContent = isText || GRAPHIC_TYPES.has(node.type);
    // Absolute non-text graphics are commonly decorative bleeds; only text clipping is always a defect.
    if (!isContent || (!isText && node.absolute)) continue;
    const ancestor = node.clipAncestors.find(({ rect }) =>
      node.rect!.x < rect.x - TOLERANCE || node.rect!.y < rect.y - TOLERANCE ||
      node.rect!.x + node.rect!.w > rect.x + rect.w + TOLERANCE ||
      node.rect!.y + node.rect!.h > rect.y + rect.h + TOLERANCE);
    if (!ancestor) continue;
    clipped += 1;
    issues.push({
      severity: isText ? "high" : "medium",
      issue: isText ? "Text is clipped by its container." : "A graphic is clipped by its container.",
      evidence: label(node) + " extends outside clipping frame " + ancestor.id + ".",
      fix: "Let the container hug its content (Auto Layout HUG), or resize/reposition the child inside the frame bounds.",
    });
  }

  return { issues, overlaps, clipped, collapsedText, textNodes: texts.length };
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ").trim().replace(/[.,:;!?…]+$/, "");
}

const NUMBER_PATTERN = /[₹$€£]?\s?\d[\d,.:/-]*\s?%?/g;

export function extractNumbers(value: string): string[] {
  const found = value.match(NUMBER_PATTERN) || [];
  return found.map(item => item.replace(/\s+/g, "").replace(/[.,:/-]+$/, "")).filter(item => /\d/.test(item));
}

function words(value: string): string[] {
  return normalizeText(value).split(/[^\p{L}\p{N}₹$€£%]+/u).filter(word => word.length >= 2);
}

const REMOVAL_INTENT = /\b(remove|delete|hide|drop|strip|declutter|simplif(y|ied)|minimal|fewer)\b/i;
const COPY_INTENT = /\b(rewrite|reword|rephrase|translate|translation|shorten|copy|copywriting|wording|text|title|heading|label|rename|placeholder|lorem|tone|localis|localiz|hindi|english)\b/i;

export function resolveContentMode(prompt: string): { mode: ContentCheck["mode"]; reason: string } {
  if (REMOVAL_INTENT.test(prompt)) return { mode: "skipped", reason: "The request asks to remove or simplify content." };
  if (COPY_INTENT.test(prompt)) return { mode: "numbers-only", reason: "The request asks for copy changes, so only numeric values are checked." };
  return { mode: "full", reason: "All visible source text and values must be preserved." };
}

function isMeaningful(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function checkContentPreservation(source: CanvasTree, output: CanvasTree, prompt: string): { content: ContentCheck; issues: StructuralLintIssue[] } {
  const { mode, reason } = resolveContentMode(prompt);
  const sourceTexts = [...new Set(source.texts.map(normalizeText).filter(isMeaningful))];
  // Short labels repeated across cards ("Pay now" on two loans) count once per copy (finding 53).
  const occurrences = (texts: string[]) => {
    const counts = new Map<string, number>();
    for (const text of texts.map(normalizeText)) if (isMeaningful(text) && text.length <= 24 && words(text).length <= 3) counts.set(text, (counts.get(text) ?? 0) + 1);
    return counts;
  };
  const sourceCounts = occurrences(source.texts);
  const outputCounts = occurrences(output.texts);
  const repeatedSlots = [...sourceCounts.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
  const content: ContentCheck = {
    mode, reason, sourceTextCount: sourceTexts.length + repeatedSlots, missingText: [], missingNumbers: [], partial: output.truncated,
  };
  const issues: StructuralLintIssue[] = [];
  if (mode === "skipped") return { content, issues };

  const joined = output.texts.map(normalizeText).join(" \n ");
  const joinedCompact = joined.replace(/\s+/g, "");
  const outputWords = new Set(output.texts.flatMap(words));

  if (mode === "full") {
    for (const text of sourceTexts) {
      if (joined.includes(text)) continue;
      const tokens = words(text);
      if (tokens.length && tokens.every(token => outputWords.has(token))) continue;
      content.missingText.push(text.slice(0, 80));
    }
    for (const [text, count] of sourceCounts) {
      const kept = outputCounts.get(text) ?? 0;
      if (count < 2 || kept === 0 || kept >= count) continue;
      for (let i = kept; i < count; i += 1) content.missingText.push((text.slice(0, 60) + " (copy " + (i + 1) + " of " + count + ")"));
    }
  }
  const sourceNumbers = [...new Set(source.texts.flatMap(extractNumbers))];
  for (const value of sourceNumbers) {
    if (!joinedCompact.includes(value.toLowerCase())) content.missingNumbers.push(value);
  }
  // Missing values already reported via their full text don't need a second finding.
  const reportedNumbers = content.missingNumbers.filter(value =>
    !content.missingText.some(text => text.replace(/\s+/g, "").includes(value.toLowerCase())));

  // A truncated output read-back cannot prove absence; report it as unverified instead.
  if (output.truncated && (content.missingText.length || reportedNumbers.length)) {
    issues.push({
      severity: "medium",
      issue: "Source content could not be fully verified because the output read-back was incomplete.",
      evidence: (content.missingText.length + reportedNumbers.length) + " source item(s) were not found in the read-back, which hit the node or depth limit.",
      fix: "Inspect the variation manually, or reduce nesting so the read-back covers the whole frame.",
    });
  } else {
    if (content.missingText.length) {
      issues.push({
        severity: "high",
        issue: content.missingText.length + " source text item(s) are missing from the output.",
        evidence: "Missing: " + content.missingText.slice(0, 6).map(text => '"' + text.slice(0, 40) + '"').join(", ") +
          (content.missingText.length > 6 ? " and " + (content.missingText.length - 6) + " more" : "") + ".",
        fix: "Add the missing text back as native TEXT layers in the matching section; do not drop source content.",
      });
    }
    if (reportedNumbers.length) {
      issues.push({
        severity: "high",
        issue: reportedNumbers.length + " source value(s) (amounts, dates, percentages) are missing from the output.",
        evidence: "Missing values: " + reportedNumbers.slice(0, 8).join(", ") + ".",
        fix: "Restore each value exactly as in the source; never invent or drop financial values.",
      });
    }
  }

  if (mode === "full" && !output.truncated) {
    const count = (tree: CanvasTree, types: string[]) => tree.nodes.filter(node => types.includes(node.type)).length;
    const sourceEllipses = count(source, ["ELLIPSE"]);
    const outputEllipses = count(output, ["ELLIPSE"]);
    if (sourceEllipses > 0 && outputEllipses === 0) {
      issues.push({
        severity: "high",
        issue: "Circular graphics from the source (progress rings, avatars, dots) are missing.",
        evidence: "Source has " + sourceEllipses + " ELLIPSE layer(s); output has none.",
        fix: "Recreate them as native ELLIPSE layers (use arcData for progress rings).",
      });
    }
    const graphicTypes = [...GRAPHIC_TYPES];
    // A short component instance that carries text (app bar, tab, chip, button) is UI chrome, not a
    // graphic: its labels are checked as text, and the renderer rebuilds it as a native header or
    // tabs block. Counting it (and the vectors inside it) failed every good run with
    // "missing App bar, Component 2/3/4" (finding 39).
    const textChrome = (tree: CanvasTree) => {
      const ids = new Set<string>();
      for (const node of tree.nodes) {
        if (node.type !== "TEXT" || !node.text.trim()) continue;
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === "INSTANCE" && p.rect && p.rect.h <= 72) { ids.add(p.id); break; }
        }
      }
      return ids;
    };
    const chromeOf = new Map<CanvasTree, Set<string>>([[source, textChrome(source)], [output, textChrome(output)]]);
    const inChrome = (tree: CanvasTree, node: FlatNode) => {
      const chrome = chromeOf.get(tree)!;
      for (let p: FlatNode | null = node; p; p = p.parent) if (chrome.has(p.id)) return true;
      return false;
    };
    const graphicNodes = (tree: CanvasTree) => tree.nodes.filter(node => (graphicTypes.includes(node.type) || node.imageFill) && !inChrome(tree, node));
    const sourceGraphics = graphicNodes(source).length;
    const outputGraphics = graphicNodes(output).length;
    // Name the dropped graphics by their nearest named container ("arrow-right", "Tabs/Vector 193").
    const label = (node: FlatNode) => {
      const named = [node.parent, node.parent?.parent].find(p => p && !/^(frame|group|vector)\b/i.test(p.name));
      return (named ? named.name + "/" : "") + node.name;
    };
    const remaining = new Map<string, number>();
    for (const node of graphicNodes(output)) remaining.set(label(node), (remaining.get(label(node)) || 0) + 1);
    const droppedNames: string[] = [];
    for (const node of graphicNodes(source)) {
      const key = label(node);
      const left = remaining.get(key) || 0;
      if (left > 0) remaining.set(key, left - 1);
      else if (!droppedNames.includes(key)) droppedNames.push(key);
    }
    // Logos, chevrons and status icons are content: losing more than a fifth of them is a failure.
    if (sourceGraphics >= 2 && outputGraphics < Math.ceil(sourceGraphics * 0.8)) {
      issues.push({
        severity: "high",
        issue: "Icons, logos or graphics from the source were dropped.",
        evidence: "Source has " + sourceGraphics + " icon/graphic layer(s); output has " + outputGraphics + "." +
          (droppedNames.length ? " Missing e.g. " + droppedNames.slice(0, 6).map(n => '"' + n.slice(0, 40) + '"').join(", ") + "." : ""),
        fix: "Keep each icon, chevron, status mark and graphic from the source, reusing component instances where they exist.",
      });
    }
  }
  if (mode === "full" && !output.truncated) {
    const lost = downgradedButtons(source, output);
    if (lost.length) {
      issues.push({
        severity: "high",
        issue: lost.length + " source button(s) are no longer buttons in the output.",
        evidence: "Not a filled button any more: " + lost.slice(0, 5).map(text => '"' + text.slice(0, 30) + '"').join(", ") + ".",
        fix: "Keep each source call to action as a filled button; do not turn it into a text link.",
      });
    }
  }
  return { content, issues };
}

/** A filled, rounded container holding exactly one text: how buttons look in a read-back. */
function buttonLabels(tree: CanvasTree): Set<string> {
  const labels = new Set<string>();
  const textsByParent = new Map<FlatNode, FlatNode[]>();
  for (const node of tree.nodes) {
    if (node.type !== "TEXT" || !node.text.trim()) continue;
    for (let p = node.parent, hops = 0; p && hops < 3; p = p.parent, hops += 1) {
      const list = textsByParent.get(p) || [];
      list.push(node);
      textsByParent.set(p, list);
    }
  }
  for (const [container, texts] of textsByParent) {
    const h = container.rect?.h ?? 0;
    if (texts.length === 1 && container.filled && container.radius > 0 && h >= 24 && h <= 64) labels.add(texts[0].text.trim().toLowerCase());
  }
  return labels;
}

function downgradedButtons(source: CanvasTree, output: CanvasTree): string[] {
  const kept = buttonLabels(output);
  const outputTexts = new Set(output.nodes.filter(n => n.type === "TEXT").map(n => n.text.trim().toLowerCase()));
  // Only labels still present as text count: a missing label is already a missing-text finding.
  return [...buttonLabels(source)].filter(label => outputTexts.has(label) && !kept.has(label));
}

const SEVERITY_ORDER: Record<LintSeverity, number> = { high: 0, medium: 1, low: 2 };

export function runStructuralLint(input: {
  prompt: string;
  sourceCanvas?: unknown;
  outputCanvas: unknown;
  sourceRootId?: string;
  outputRootId?: string;
}): StructuralLintResult {
  const output = flattenCanvas(input.outputCanvas, input.outputRootId);
  const layout = lintLayout(output);
  const source = input.sourceCanvas ? flattenCanvas(input.sourceCanvas, input.sourceRootId) : null;
  const preservation = source && source.nodes.length
    ? checkContentPreservation(source, output, input.prompt)
    : {
      content: { mode: "skipped" as const, reason: "No source layer tree was provided.", sourceTextCount: 0, missingText: [], missingNumbers: [], partial: output.truncated },
      issues: [],
    };
  const issues = [...preservation.issues, ...layout.issues]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_ISSUES);
  return {
    passed: output.nodes.length > 0 && issues.length === 0,
    issues,
    layout: { textNodes: layout.textNodes, overlaps: layout.overlaps, clipped: layout.clipped, collapsedText: layout.collapsedText },
    content: preservation.content,
  };
}

/** One-line human summary for plugin status text. */
export function summarizeStructuralLint(result: StructuralLintResult): string {
  const content = result.content.mode === "skipped"
    ? "content check skipped (" + result.content.reason + ")"
    : (result.content.sourceTextCount - result.content.missingText.length) + "/" + result.content.sourceTextCount +
      " source texts kept, " + result.content.missingNumbers.length + " value(s) missing";
  return (result.passed ? "Structural lint passed" : "Structural lint found " + result.issues.length + " issue(s)") +
    " · " + content + " · " + result.layout.overlaps + " overlap(s), " + result.layout.clipped + " clipped, " +
    result.layout.collapsedText + " collapsed text";
}
