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

// Keys free models use instead of `operation`, and harmless commentary keys they add to each action.
// Both are normalised before strict validation (schema drift is a format slip, not a bad plan).
const OPERATION_ALIASES = ["action", "op", "type", "command", "operationId", "operation_id"];
const OPERATION_SHAPE = /^[a-z][a-z0-9]*(?:[-_ ]?[a-zA-Z0-9]+)*$/i;
const KEY_ALIASES: Record<string, string> = {
  node_id: "nodeId", id: "nodeId", targetId: "nodeId", target_id: "nodeId", targetNodeId: "nodeId", layerId: "nodeId",
  parent_id: "parentNodeId", parentId: "parentNodeId", node_ids: "nodeIds", ids: "nodeIds", targetIds: "nodeIds",
  component_id: "componentId", page_id: "pageId", page_name: "pageName", style_id: "styleId", style_name: "styleName",
  properties: "patch", props: "patch", changes: "patch", updates: "patch", set: "patch",
};
const COMMENTARY_KEYS = ["description", "reason", "reasoning", "explanation", "rationale", "comment", "note", "notes", "why", "label", "title", "step", "stepNumber", "summary"];

function isAction(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  if (typeof value.operation === "string") return true;
  return OPERATION_ALIASES.some((key) => typeof value[key] === "string" && OPERATION_SHAPE.test(String(value[key])));
}

/** "UPDATE_NODE", "updateNode", "update node" -> "update-node". */
export function normaliseOperationId(value: string): string {
  return value.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();
}

/** One action object with alias keys renamed to the schema's names and commentary keys dropped. */
export function normaliseAction(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const action: JsonRecord = { ...value };
  if (typeof action.operation !== "string") {
    const alias = OPERATION_ALIASES.find((key) => typeof action[key] === "string" && OPERATION_SHAPE.test(String(action[key])));
    if (alias) {
      action.operation = action[alias];
      delete action[alias];
    }
  }
  // `action`/`op` left next to a real `operation` is a duplicate label.
  for (const key of OPERATION_ALIASES) if (typeof action.operation === "string" && typeof action[key] === "string") delete action[key];
  if (typeof action.operation === "string") action.operation = normaliseOperationId(action.operation);
  for (const [from, to] of Object.entries(KEY_ALIASES)) {
    if (from in action && !(to in action)) {
      const v = action[from];
      // A patch alias must be an object; a node id alias must be a string.
      if (to === "patch" ? isRecord(v) : to === "nodeIds" ? Array.isArray(v) : typeof v === "string") { action[to] = v; delete action[from]; }
    }
  }
  applyPatchShortcut(action);
  for (const key of COMMENTARY_KEYS) if (typeof action[key] === "string" || typeof action[key] === "number") delete action[key];
  return action;
}

// Property shortcuts free models invent ("hide-node", "set-opacity", "rename") are all one
// update-node patch; `fixed` is the patch they imply, `fields` are the action keys that move into it.
const PATCH_SHORTCUTS: Array<[RegExp, Record<string, unknown>, string[]]> = [
  [/^(hide|hide-node|hide-layer|set-hidden)$/, { visible: false }, []],
  [/^(show|unhide|show-node|show-layer|unhide-node)$/, { visible: true }, []],
  [/^(lock|lock-node|lock-layer)$/, { locked: true }, []],
  [/^(unlock|unlock-node|unlock-layer)$/, { locked: false }, []],
  [/^(set-visible|set-visibility|toggle-visibility)$/, {}, ["visible"]],
  [/^(set-locked|set-lock)$/, {}, ["locked"]],
  [/^(rename|rename-node|rename-layer|set-name)$/, {}, ["name"]],
  [/^(set-opacity|change-opacity)$/, {}, ["opacity"]],
  [/^(resize|resize-node|set-size)$/, {}, ["width", "height"]],
  [/^(move|move-node|set-position)$/, {}, ["x", "y"]],
  [/^(set-text|update-text|edit-text|change-text)$/, {}, ["text", "characters"]],
  [/^(set-spacing|set-gap|set-item-spacing)$/, {}, ["itemSpacing", "gap", "spacing"]],
  [/^(set-padding)$/, {}, ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"]],
  [/^(update|edit|modify|set-property|set-properties|update-properties|update-node-properties|patch-node|update-layer)$/, {}, []],
];
const PATCH_FIELD_ALIASES: Record<string, string> = { characters: "text", gap: "itemSpacing", spacing: "itemSpacing" };

function applyPatchShortcut(action: JsonRecord): void {
  if (typeof action.operation !== "string") return;
  const hit = PATCH_SHORTCUTS.find(([re]) => re.test(action.operation as string));
  if (!hit) return;
  const [, fixed, fields] = hit;
  const patch: JsonRecord = isRecord(action.patch) ? { ...action.patch } : {};
  for (const field of fields) {
    if (action[field] === undefined) continue;
    const target = PATCH_FIELD_ALIASES[field] || field;
    if (patch[target] === undefined) patch[target] = action[field];
    delete action[field];
  }
  Object.assign(patch, fixed);
  action.operation = "update-node";
  action.patch = patch;
}

function normaliseActions(list: unknown[]): unknown[] {
  return list.map(normaliseAction);
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
    return value.length && value.every(isAction) ? { summary: DEFAULT_SUMMARY, actions: normaliseActions(value) } : value;
  }
  if (!isRecord(value)) return value;
  for (const key of ALTERNATE_KEYS) {
    const list = value[key];
    if (Array.isArray(list) && list.length && list.every(isAction)) {
      return { summary: summaryOf(value.summary), actions: normaliseActions(list) };
    }
  }
  if (Array.isArray(value.actions)) return { summary: summaryOf(value.summary), actions: normaliseActions(value.actions) };
  if (isAction(value)) {
    const summary = summaryOf(value.summary);
    return { summary, actions: [normaliseAction(value)] };
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
