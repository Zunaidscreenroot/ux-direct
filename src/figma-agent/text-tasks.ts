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

export function normalizeTextEdits(mode: TextTaskMode, data: unknown, items: TextTaskItem[], raw = "", prompt = ""): TextEdit[] {
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
  const push = (source: TextTaskItem, value: string | null) => {
    if (value === null || seen.has(source.id)) return;
    if (mode === "rewrite") {
      if (source.type !== "TEXT" || !value.trim() || value.length > 5000 || value === (source.text || "")) return;
      // Whitespace-only "changes" are no-ops (tester: "Personal Loan " → "Personal Loan" ×3).
      const squash = (text: string) => text.replace(/\s+/g, " ").trim();
      if (squash(value) === squash(source.text || "")) return;
      // A copy rewrite never touches IDs, amounts or dates unless the request is about them.
      if (!allowValueEdits && isValueText(source.text || "")) return;
      edits.push({ id: source.id, value, before: source.text || "" });
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
