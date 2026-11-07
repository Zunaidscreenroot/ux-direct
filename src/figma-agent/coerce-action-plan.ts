// Free models answer the native-action planner in several near-miss shapes: a bare array of actions,
// a single action object, `steps`/`operations` instead of `actions`, a fenced block or prose around the
// JSON. Each is normalised to { summary, actions } before schema validation, so a usable plan is not
// rejected as "response has no actions array".

type JsonRecord = Record<string, unknown>;
const DEFAULT_SUMMARY = "Native Figma edit";
const ALTERNATE_KEYS = ["actions", "steps", "operations", "commands", "plan", "edits"];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is JsonRecord {
  return isRecord(value) && typeof value.operation === "string";
}

function summaryOf(value: unknown): string {
  return typeof value === "string" && value.trim().length >= 4 ? value.trim().slice(0, 500) : DEFAULT_SUMMARY;
}

/** Parses the first JSON object or array in free text (code fences and surrounding prose allowed). */
export function parseLooseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  const text = value.replace(/```(?:json)?/gi, "").trim();
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const close = text[start] === "{" ? "}" : "]";
    for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try a shorter span */ }
    }
  }
  return null;
}

export function coerceActionPlan(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return value.length && value.every(isAction) ? { summary: DEFAULT_SUMMARY, actions: value } : value;
  }
  if (!isRecord(value)) return value;
  for (const key of ALTERNATE_KEYS) {
    const list = value[key];
    if (Array.isArray(list) && list.length && list.every(isAction)) {
      return { summary: summaryOf(value.summary), actions: list };
    }
  }
  if (Array.isArray(value.actions)) return { ...value, summary: summaryOf(value.summary) };
  if (isAction(value)) {
    const action: JsonRecord = { ...value };
    const summary = summaryOf(action.summary);
    delete action.summary;
    return { summary, actions: [action] };
  }
  if (depth < 2) {
    for (const key of ["data", "result", "response", "output", "plan"]) {
      if (isRecord(value[key]) || Array.isArray(value[key])) {
        const inner = coerceActionPlan(value[key], depth + 1);
        if (isRecord(inner) && Array.isArray(inner.actions)) return inner;
      }
    }
  }
  return value;
}
