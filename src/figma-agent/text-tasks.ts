/** Validation for model-proposed text and layer-name edits: only known ids, only real changes. */

export type TextTaskItem = { id: string; name: string; type: string; text?: string };
export type TextEdit = { id: string; value: string; before: string };

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeTextEdits(mode: "rewrite" | "rename", data: unknown, items: TextTaskItem[]): TextEdit[] {
  const root = rec(data);
  if (!root) return [];
  const raw = (mode === "rewrite"
    ? [root.updates, root.edits, root.changes, root.texts]
    : [root.names, root.renames, root.layers, root.updates]
  ).find(Array.isArray) as unknown[] | undefined;
  if (!raw) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const edits: TextEdit[] = [];
  for (const entry of raw) {
    const item = rec(entry);
    if (!item || typeof item.id !== "string") continue;
    const source = byId.get(item.id);
    if (!source || seen.has(item.id)) continue;
    if (mode === "rewrite") {
      if (source.type !== "TEXT") continue;
      const value = typeof item.text === "string" ? item.text : typeof item.value === "string" ? item.value : null;
      if (value === null || !value.trim() || value.length > 5000 || value === (source.text || "")) continue;
      edits.push({ id: item.id, value, before: source.text || "" });
    } else {
      const value = typeof item.name === "string" ? item.name : typeof item.value === "string" ? item.value : null;
      const clean = value ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      if (!clean || clean === source.name) continue;
      edits.push({ id: item.id, value: clean, before: source.name });
    }
    seen.add(item.id);
  }
  return edits;
}
