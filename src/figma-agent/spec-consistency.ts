/**
 * Model-agnostic consistency for block specs.
 *
 * FreeLLMAPI `auto` can route the same task to Gemini, GLM, Qwen or another free model.
 * Everything here is deterministic so the rendered result depends on the source screen,
 * not on which model answered:
 *  - the palette comes from the source frame unless the user asked for a visual restyle;
 *  - source text a model dropped is put back instead of being lost (or costing a retry);
 *  - a verified earlier spec is reduced to its structure so any model can follow it
 *    without copying another screen's content.
 */

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}

function hex(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function channels(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function saturation(color: string): number {
  const [r, g, b] = channels(color);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * l - 1));
}

function lightness(color: string): number {
  const [r, g, b] = channels(color);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

/** True when the prompt asks to change colours/theme, so the model's palette is wanted. */
export function promptRequestsRestyle(prompt: string): boolean {
  return /\b(colou?rs?|theme|palette|dark\s*mode|light\s*mode|brand(ing)?|restyle|re-?skin|gradient|wire\s*-?\s*frames?|lo-?fi|low[\s-]?fi(delity)?|grey\s*box|gray\s*box|rang|kala|dark|night)\b|रंग|कलर|थीम|डार्क/iu.test(prompt);
}

type Tally = Map<string, number>;
function bump(map: Tally, key: string | null, weight = 1) {
  if (key) map.set(key, (map.get(key) || 0) + weight);
}
function top(map: Tally, exclude: Set<string> = new Set()): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of map) {
    if (!exclude.has(key) && count > bestCount) { best = key; bestCount = count; }
  }
  return best;
}

/** Palette read from the source layer tree. Only keys with real evidence are returned. */
export function sourcePalette(canvas: Rec): Rec {
  const roots = Array.isArray(canvas.nodes) ? canvas.nodes.map(asRec).filter((n): n is Rec => !!n) : [];
  const root = roots[0];
  if (!root) return {};
  const background = Array.isArray(root.fillColors) ? hex(root.fillColors[0]) : null;
  const textFills: Tally = new Map();
  const accentFills: Tally = new Map();
  const surfaceFills: Tally = new Map();
  const visit = (node: Rec, depth: number) => {
    if (depth > 8) return;
    const fill = Array.isArray(node.fillColors) ? hex(node.fillColors[0]) : null;
    const name = typeof node.name === "string" ? node.name : "";
    if (node.type === "TEXT") bump(textFills, fill);
    else if (fill && depth > 0) {
      if (saturation(fill) >= 0.35 && lightness(fill) > 0.15 && lightness(fill) < 0.85) {
        bump(accentFills, fill, /button|btn|cta|primary|action|tab|active|selected/i.test(name) ? 3 : 1);
      } else if (fill !== background && saturation(fill) < 0.25) {
        bump(surfaceFills, fill);
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const rec = asRec(child);
      if (rec) visit(rec, depth + 1);
    }
  };
  visit(root, 0);
  const out: Rec = {};
  if (background) out.background = background;
  const text = top(textFills);
  if (text) out.text = text;
  const muted = text ? top(textFills, new Set([text])) : null;
  if (muted) out.muted = muted;
  const primary = top(accentFills);
  if (primary) out.primary = primary;
  const surface = top(surfaceFills, new Set(background ? [background] : []));
  if (surface) out.surface = surface;
  return out;
}

/**
 * Theme the renderer should use. Without a restyle request the source palette wins and
 * any colour a model invented is dropped (the renderer's fixed defaults fill the gaps),
 * so two different models produce the same colours for the same screen.
 */
export function lockTheme(modelTheme: unknown, canvas: Rec, prompt: string): { theme: Rec; locked: boolean } {
  const model = asRec(modelTheme) ?? {};
  if (promptRequestsRestyle(prompt)) return { theme: { ...sourcePalette(canvas), ...model }, locked: false };
  return { theme: sourcePalette(canvas), locked: true };
}

/** Returns the spec with a theme fixed for consistency. Does not mutate the input. */
export function stabilizeBlockSpec(spec: unknown, canvas: Rec, prompt: string): { spec: Rec; themeLocked: boolean } {
  const rec = asRec(spec) ?? {};
  const frame = asRec(rec.frame) ?? {};
  const { theme, locked } = lockTheme(rec.theme ?? frame.theme, canvas, prompt);
  const nextFrame = { ...frame };
  delete nextFrame.theme;
  // frame.backgroundColor also feeds the renderer; keep it in line with the locked theme.
  if (locked) delete nextFrame.backgroundColor;
  return { spec: { ...rec, frame: nextFrame, theme }, themeLocked: locked };
}

const TRAILING_SECTION = /action|button|cta|footer|bottom|nav|tab bar|submit|continue/i;

/**
 * Put dropped source strings back as a "More details" list. Placed before a trailing
 * actions/nav section so the primary action stays last.
 */
export function appendMissingSourceText(spec: unknown, missing: string[]): Rec {
  const rec = asRec(spec) ?? {};
  const sections = Array.isArray(rec.sections) ? [...rec.sections] : [];
  if (!missing.length) return { ...rec, sections };
  const section = {
    name: "More details",
    surface: "card",
    blocks: [{ type: "list", items: missing.map((text) => ({ label: text })) }],
  };
  const last = asRec(sections[sections.length - 1]);
  const lastName = last ? String(last.name ?? last.title ?? "") : "";
  if (last && TRAILING_SECTION.test(lastName) && sections.length > 1) sections.splice(sections.length - 1, 0, section);
  else sections.push(section);
  return { ...rec, sections: sections.slice(0, 8) };
}

/** Max dropped strings the repair will restore; beyond this the model attempt is rejected. */
export const MAX_REPAIRED_TEXTS = 10;

const STRUCTURAL_KEYS = new Set(["type", "surface", "tone", "statusTone", "variant", "layout", "dropdown", "checked", "chevron", "back"]);

/**
 * Structure-only copy of a verified spec: block types, nesting, tones and counts survive;
 * every content string becomes a placeholder so another screen's text can't leak.
 */
export function structuralExample(spec: unknown): Rec | null {
  const rec = asRec(spec);
  if (!rec || !Array.isArray(rec.sections)) return null;
  const strip = (value: unknown, key: string, depth: number): unknown => {
    if (depth > 6) return undefined;
    if (typeof value === "string") return STRUCTURAL_KEYS.has(key) ? value.slice(0, 20) : "<source text>";
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 6).map((item) => strip(item, key, depth + 1));
    const obj = asRec(value);
    if (!obj) return undefined;
    const out: Rec = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "componentId" || k === "instanceProperties" || k === "node" || k === "learningCandidate") continue;
      const next = strip(v, k, depth + 1);
      if (next !== undefined) out[k] = next;
    }
    return out;
  };
  const sections = rec.sections.slice(0, 8).map((section) => {
    const s = asRec(section);
    if (!s) return null;
    const out = strip(s, "", 0) as Rec;
    // Section names describe structure ("Loan summary"); keep them short but readable.
    if (typeof s.name === "string") out.name = s.name.slice(0, 40);
    return out;
  }).filter(Boolean);
  return sections.length ? { sections } : null;
}

export type VerifiedRun = { plan?: unknown; metadata?: unknown };

/**
 * Bumped whenever the verification lint gets stricter. Runs verified under an older,
 * looser lint (e.g. before graphics/CTA checks) are never served as team examples.
 */
export const VERIFIED_LINT_VERSION = 2;

/** Pick the best verified spec for this scope: same selection kind, highest quality, newest first. */
export function pickVerifiedExample(rows: VerifiedRun[], designScope: string): Rec | null {
  const candidates = rows.flatMap((row) => {
    const plan = asRec(row.plan);
    const meta = asRec(row.metadata) ?? {};
    // Source-fallback rebuilds are never a model example, whatever their outcome.
    if (!plan || meta.planFormat !== "blocks" || meta.repairedTexts || meta.sourceFallback === true || meta.model === "source-fallback") return [];
    if (typeof meta.lintVersion !== "number" || meta.lintVersion < VERIFIED_LINT_VERSION) return [];
    const example = structuralExample(plan);
    if (!example) return [];
    const score = typeof meta.qualityScore === "number" ? meta.qualityScore : 0;
    return [{ example, score: score + (meta.designScope === designScope ? 100 : 0) }];
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.example ?? null;
}
