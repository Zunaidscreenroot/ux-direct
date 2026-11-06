type Rec = Record<string, unknown>;

const DEFAULT_LAYER_NAME = /^(frame|group|rectangle|ellipse|vector|line|text|instance|component|union|subtract|polygon|star|image|layer)\s*\d*$/i;

/**
 * Retrieval query for the shared brain: what the task is about, not raw canvas JSON.
 * Ids, coordinates and fills only add noise to text search, so the query keeps the prompt,
 * the frame name, the scope and the most telling layer names and texts.
 */
export function buildBrainQuery(input: { prompt: string; frameName?: string; designScope?: string; nodes?: unknown[] }): string {
  const layerNames: string[] = [];
  const texts: string[] = [];
  const seen = new Set<string>();
  const visit = (items: unknown[], depth: number) => {
    if (depth > 6) return;
    for (const value of items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Rec;
      if (node.type === "TEXT" && typeof node.text === "string") {
        const text = node.text.replace(/\s+/g, " ").trim();
        const key = "t:" + text.toLowerCase();
        // Short labels describe the screen; long copy, numbers and amounts do not help retrieval.
        if (text.length >= 3 && text.length <= 40 && /[a-z]{3}/i.test(text) && !seen.has(key) && texts.length < 25) {
          seen.add(key); texts.push(text);
        }
      } else if (typeof node.name === "string") {
        const name = node.name.replace(/\s+/g, " ").trim().slice(0, 40);
        const key = "n:" + name.toLowerCase();
        if (name.length >= 3 && !DEFAULT_LAYER_NAME.test(name) && !seen.has(key) && layerNames.length < 20) {
          seen.add(key); layerNames.push(name);
        }
      }
      if (Array.isArray(node.children)) visit(node.children, depth + 1);
    }
  };
  visit(Array.isArray(input.nodes) ? input.nodes : [], 0);
  const lines = [
    input.prompt.trim().slice(0, 1200),
    input.frameName ? "Screen: " + input.frameName.slice(0, 80) : "",
    input.designScope ? "Scope: " + input.designScope.replace(/_/g, " ") : "",
    layerNames.length ? "Layers: " + layerNames.join(", ") : "",
    texts.length ? "Text: " + texts.join(", ") : "",
  ].filter(Boolean);
  return lines.join("\n").slice(0, 2400);
}
