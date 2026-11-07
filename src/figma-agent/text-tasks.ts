/**
 * Text quick tasks: what the model sees and how its answer is mapped back to layers.
 *
 * Free models garble long Figma ids ("123:4567;89:10") and vary the JSON shape, so each
 * layer gets a short ref (t1, t2, …) and the parser accepts every shape seen in practice:
 * {updates:[…]}, any array of objects, a bare array, a {ref: text} map, or a single
 * {text} answer when only one layer was selected. Entries are matched by ref, id, or
 * unique layer name. Only real changes to known layers survive.
 */

export type TextTaskItem = { id: string; name: string; type: string; text?: string; hint?: string; parent?: string; fontSize?: number };
export type TextEdit = { id: string; value: string; before: string };
export type TextTaskMode = "rewrite" | "rename";

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function refFor(index: number): string {
  return "t" + (index + 1);
}

/** The compact layer list sent to the model. */
export function modelLayers(mode: TextTaskMode, items: TextTaskItem[]): Array<Record<string, unknown>> {
  return items.map((item, index) => mode === "rewrite"
    ? { ref: refFor(index), name: item.name.slice(0, 60), text: item.text || "", ...(item.fontSize ? { fontSize: item.fontSize } : {}), ...(item.parent ? { parent: item.parent.slice(0, 60) } : {}) }
    : { ref: refFor(index), type: item.type, name: item.name.slice(0, 60), ...(item.hint ? { hint: item.hint } : {}), ...(item.parent ? { parent: item.parent.slice(0, 60) } : {}) });
}

const VALUE_KEYS: Record<TextTaskMode, string[]> = {
  rewrite: ["text", "newText", "new_text", "value", "updated", "updatedText", "updated_text", "rewritten", "rewrite", "content", "copy", "after", "result", "output"],
  rename: ["name", "newName", "new_name", "value", "label", "layerName", "layer_name", "after", "result"],
};
const ID_KEYS = ["ref", "id", "layer", "layerId", "layer_id", "nodeId", "node_id", "key", "target"];

/** Pulls JSON arrays out of raw model text (fenced or not), for answers that are a bare array. */
function arraysFromRaw(raw: string): unknown[][] {
  const found: unknown[][] = [];
  const cleaned = raw.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) found.push(parsed);
    } catch { /* not a JSON array */ }
  }
  return found;
}

function candidateEntries(data: unknown, raw: string): unknown[] {
  const root = rec(data);
  const entries: unknown[] = [];
  if (root) {
    for (const value of Object.values(root)) {
      if (Array.isArray(value)) entries.push(...value);
      const nested = rec(value);
      if (nested) for (const inner of Object.values(nested)) if (Array.isArray(inner)) entries.push(...inner);
    }
    if (ID_KEYS.some((key) => key in root)) entries.push(root);
    // Map form: {"t1": "new text", "t2": "…"} or {"t1": {text: …}}.
    for (const [key, value] of Object.entries(root)) {
      if (/^t\d+$/i.test(key) || /^\d+:\d+/.test(key)) {
        if (typeof value === "string") entries.push({ ref: key, value });
        else if (rec(value)) entries.push({ ref: key, ...rec(value)! });
      }
    }
  }
  if (!entries.length && raw) for (const array of arraysFromRaw(raw)) entries.push(...array);
  return entries;
}

/** Values and IDs ("₹1,07,649", "60%", "DMI1234567890", "12 Nov 2026") are data, not copy. */
export function isValueText(text: string): boolean {
  const value = text.trim();
  if (!value || !/\d/.test(value)) return false;
  if (!/\s/.test(value)) return true;
  return /^[\d₹$€£¥%.,:/+\-\s]+([a-z]{3,9}\.?)?[\d,\s]*$/i.test(value) && value.replace(/[^a-z]/gi, "").length <= 9;
}

const VALUE_EDIT_REQUEST = /\b(numbers?|amounts?|values?|ids?|dates?|prices?|figures?|data|currency|format|translate|hindi|placeholder|sample|dummy)\b/i;

const TITLE_REQUEST = /\b(titles?|headings?|headers?|screen names?|page names?|rename the screen)\b/i;
const LONGER_REQUEST = /\b(expand|longer|lengthen|elaborate|more detail|add (?:more|context|words))\b/i;
// The screen title: text inside the app bar / top navigation, or a layer named as the page title.
// A card's own "Title" layer is ordinary copy and may be rewritten.
const SCREEN_TITLE_PARENT = /\b(app ?bar|nav(?:igation)? ?bar|navigation|toolbar|top ?bar|header)\b/i;
const SCREEN_TITLE_NAME = /\b(screen|page) ?(title|heading|name)\b/i;
const SHORT_LABEL_LAYER = /\b(tabs?|segment\w*|chips?|pills?|badges?|buttons?|btn|cta)\b/i;
const PUNCTUATION_REQUEST = /\b(punctuat\w*|full ?stops?|periods?|commas?|apostroph\w*|quotes?|hyphen\w*)\b/i;


// Compact labels that are standard in dense rows; a rewrite keeps them instead of spelling them out ("Qty 1" → "Quantity: 1").
const STANDARD_ABBREVIATIONS = new Set(["qty", "eta", "emi", "amt", "avg", "approx", "dept", "pcs", "hrs", "hr", "mins", "secs", "est", "incl", "excl", "txn", "dob", "faq", "kyc", "otp", "upi", "gst", "vat", "a/c", "acct", "yr", "yrs", "mo", "km", "kg"]);
const CASE_REQUEST = /\b(case|capitali[sz]\w*|title case|sentence case|uppercase|lowercase)\b/i;
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "via", "with", "&"]);

type LabelCase = "title" | "sentence" | null;
const wordList = (text: string) => text.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
function labelCase(text: string): LabelCase {
  const words = wordList(text);
  if (words.length < 2 || words.length > 6) return null;
  const rest = words.slice(1).filter((w) => !SMALL_WORDS.has(w.toLowerCase()) && !/^\p{Lu}{2,}$/u.test(w));
  if (!rest.length || !/^\p{Lu}/u.test(words[0])) return null;
  if (rest.every((w) => /^\p{Lu}/u.test(w))) return "title";
  if (rest.every((w) => /^\p{Ll}/u.test(w))) return "sentence";
  return null;
}
/** The case most short labels on the screen already use; null when it's unclear. */
export function dominantLabelCase(texts: string[]): LabelCase {
  let title = 0, sentence = 0;
  for (const text of texts) { const c = labelCase(text); if (c === "title") title += 1; else if (c === "sentence") sentence += 1; }
  if (title + sentence < 2) return null;
  if (title >= sentence * 2) return "title";
  if (sentence >= title * 2) return "sentence";
  return null;
}
/** Applies the screen's label case to a short label; proper nouns and acronyms from the screen keep their case. */
export function applyLabelCase(text: string, target: LabelCase, keep: Set<string>): string {
  if (!target || wordList(text).length > 6 || /[.!?]\s/.test(text)) return text;
  let index = 0;
  return text.replace(/\S+/g, (word) => {
    if (!/\p{L}/u.test(word)) return word;
    const first = index === 0;
    index += 1;
    if (/^\p{Lu}{2,}/u.test(word) || keep.has(word)) return word;
    const lower = word.toLowerCase();
    if (first) return lower.charAt(0).toUpperCase() + lower.slice(1);
    if (target === "title") return SMALL_WORDS.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    return lower;
  });
}

/**
 * The screen title when no app bar names it: the first of the leading texts set in the largest
 * size on the screen (a plain header like "Settings" at 20–28 px above the content).
 */
export function inferScreenTitleId(items: TextTaskItem[]): string | null {
  const texts = items.filter((item) => item.type === "TEXT" && (item.text || "").trim());
  const sizes = texts.map((item) => item.fontSize || 0);
  const max = Math.max(0, ...sizes);
  if (max < 18) return null;
  const leading = texts.slice(0, 5).find((item) => (item.fontSize || 0) === max && wordList(item.text || "").length <= 6);
  return leading ? leading.id : null;
}

export function normalizeTextEdits(mode: TextTaskMode, data: unknown, items: TextTaskItem[], raw = "", prompt = "", screenName = ""): TextEdit[] {
  const allowValueEdits = VALUE_EDIT_REQUEST.test(prompt);
  const byRef = new Map(items.map((item, index) => [refFor(index), item]));
  const byId = new Map(items.map((item) => [item.id, item]));
  const nameCounts = new Map<string, number>();
  items.forEach((item) => nameCounts.set(item.name.trim().toLowerCase(), (nameCounts.get(item.name.trim().toLowerCase()) || 0) + 1));
  const byName = new Map(items.filter((item) => nameCounts.get(item.name.trim().toLowerCase()) === 1).map((item) => [item.name.trim().toLowerCase(), item]));

  const resolve = (entry: Record<string, unknown>): TextTaskItem | null => {
    for (const key of ID_KEYS) {
      const value = entry[key];
      if (typeof value !== "string" && typeof value !== "number") continue;
      const text = String(value).trim();
      const ref = byRef.get(text.toLowerCase()) || byRef.get("t" + text.replace(/^t/i, ""));
      if (ref && (/^t?\d+$/i.test(text))) return ref;
      if (byId.has(text)) return byId.get(text)!;
      const named = byName.get(text.toLowerCase());
      if (named) return named;
    }
    const named = typeof entry.name === "string" && mode === "rewrite" ? byName.get(entry.name.trim().toLowerCase()) : undefined;
    return named || null;
  };
  const valueOf = (entry: Record<string, unknown>): string | null => {
    for (const key of VALUE_KEYS[mode]) if (typeof entry[key] === "string") return entry[key] as string;
    return null;
  };

  const seen = new Set<string>();
  const edits: TextEdit[] = [];
  const inferredTitleId = mode === "rewrite" ? inferScreenTitleId(items) : null;
  const titleText = (items.find((item) => item.id === inferredTitleId)?.text || screenName || "").toLowerCase();
  const titleWords = new Set(titleText.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2).map((w) => w.replace(/s$/, "")));
  const screenCase = mode === "rewrite" && !CASE_REQUEST.test(prompt) ? dominantLabelCase(items.map((item) => item.text || "")) : null;
  // Capitalised words that sit mid-label on the screen are names or acronyms; case alignment keeps them.
  const keepCase = new Set(items.flatMap((item) => (item.text || "").split(/\s+/).slice(1).filter((w) => /^\p{Lu}/u.test(w) && labelCase(item.text || "") !== "title")));
  const push = (source: TextTaskItem, value: string | null) => {
    if (value === null || seen.has(source.id)) return;
    if (mode === "rewrite") {
      if (source.type !== "TEXT" || !value.trim() || value.length > 5000 || value === (source.text || "")) return;
      // Whitespace-only "changes" are no-ops (tester: "Personal Loan " → "Personal Loan" ×3).
      const squash = (text: string) => text.replace(/\s+/g, " ").trim();
      if (squash(value) === squash(source.text || "")) return;
      // Punctuation-only "changes" are no-ops too (tester: a dropped full stop counted as a rewrite).
      const words = (text: string) => squash(text.replace(/\p{P}+/gu, ""));
      if (!PUNCTUATION_REQUEST.test(prompt) && words(value) === words(source.text || "")) return;
      // The screen title stays unless the request is about titles (tester: "Manage Loans" → "Loan Management" twice).
      const where = source.name + " " + (source.parent || "") + " " + (source.hint || "");
      const isScreenTitle = SCREEN_TITLE_PARENT.test(source.parent || "") || SCREEN_TITLE_NAME.test(source.name) ||
        (!!screenName.trim() && squash(source.text || "").toLowerCase() === squash(screenName).toLowerCase()) || source.id === inferredTitleId;
      if (!TITLE_REQUEST.test(prompt) && isScreenTitle) return;
      // Tabs, chips and buttons keep their width: at most ~1.2× the source length ("Others" → "Other Loans" overflows a 3-tab bar).
      const before = squash(source.text || "");
      if (!LONGER_REQUEST.test(prompt) && SHORT_LABEL_LAYER.test(where) && squash(value).length > Math.max(before.length * 1.2, before.length + 2)) return;
      // A copy rewrite never touches IDs, amounts or dates unless the request is about them.
      if (!allowValueEdits && isValueText(source.text || "")) return;
      const tokens = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}/]+/u).filter(Boolean);
      const oldTokens = tokens(before), newTokens = tokens(value);
      if (!LONGER_REQUEST.test(prompt)) {
        // A standard abbreviation is kept, not spelled out.
        if (oldTokens.some((t) => STANDARD_ABBREVIATIONS.has(t) && !newTokens.includes(t))) return;
        // A label that only gains the screen's own topic word is redundant ("Privacy" → "Privacy settings" on Settings).
        const added = newTokens.filter((t) => !oldTokens.includes(t));
        if (added.length && oldTokens.every((t) => newTokens.includes(t)) && added.every((t) => titleWords.has(t.replace(/s$/, "")))) return;
      }
      // One case across the screen's labels: an edited label follows the case most labels already use.
      const cased = applyLabelCase(value, screenCase, keepCase);
      if (squash(cased) === before) return;
      edits.push({ id: source.id, value: cased, before: source.text || "" });
    } else {
      const clean = value.replace(/\s+/g, " ").trim().slice(0, 60);
      if (!clean || clean === source.name) return;
      edits.push({ id: source.id, value: clean, before: source.name });
    }
    seen.add(source.id);
  };

  for (const candidate of candidateEntries(data, raw)) {
    const entry = rec(candidate);
    if (!entry) continue;
    const source = resolve(entry);
    if (source) push(source, valueOf(entry));
  }
  // One selected layer and a single answer without a ref: {"text": "…"}.
  const root = rec(data);
  if (!edits.length && items.length === 1 && root) push(items[0], valueOf(root));
  return edits;
}

const GENERIC_NAME = /^(frame|rectangle|group|ellipse|vector|text|line|polygon|star|union|subtract|intersect|exclude|image|component|instance|section)(\s+\d+)?$/i;

/** Model-free fallback for rename: names default-named layers from their content and shape. */
export function deterministicLayerNames(items: TextTaskItem[]): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const item of items) {
    if (!GENERIC_NAME.test(item.name.trim())) continue;
    const hint = item.hint || "";
    const text = /text:\s*([^|]+?)(?:\s*\||\s+children:|\s+size:|$)/.exec(hint)?.[1]?.trim() || "";
    const size = /size:\s*(\d+)x(\d+)/.exec(hint);
    const w = size ? Number(size[1]) : 0;
    const h = size ? Number(size[2]) : 0;
    let name = "";
    if (text) {
      const words = text.replace(/[^\p{L}\p{N}₹$€£%&,.\s-]/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
      name = words.replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase());
      if (/^(FRAME|GROUP|INSTANCE|COMPONENT)$/.test(item.type) && w && h && h <= 64 && w <= 360) name += " Button";
      else if (/^(FRAME|GROUP)$/.test(item.type)) name += " Section";
    } else if (/^(VECTOR|BOOLEAN_OPERATION|STAR|POLYGON)$/.test(item.type) || (w && h && w <= 48 && h <= 48)) name = "Icon";
    else if (item.type === "LINE" || (w && h && Math.min(w, h) <= 2)) name = "Divider";
    else if (item.type === "ELLIPSE") name = "Circle";
    else if (item.type === "RECTANGLE") name = "Background";
    else name = "Container";
    if (name && name !== item.name) edits.push({ id: item.id, value: name.slice(0, 60), before: item.name });
  }
  return edits;
}
