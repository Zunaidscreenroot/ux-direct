type JsonRecord = Record<string, unknown>;

type NativePlanLike = JsonRecord & { summary: unknown; frame: unknown; elements: unknown };

const PLAN_KEYS = ["summary", "frame", "elements"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlanObject(value: unknown): value is NativePlanLike {
  if (!isRecord(value)) return false;
  if (PLAN_KEYS.every((key) => key in value)) return true;
  // Block specs (the default plan format) carry sections instead of a raw layer tree.
  return Array.isArray(value.sections) && !("elements" in value) && ("summary" in value || "frame" in value || value.sections.length > 0);
}

const WRAPPER_KEYS = ["parsed", "json", "output", "content", "text", "arguments", "input",
  "plan", "spec", "blockSpec", "block_spec", "design", "screen", "result", "data", "response"];

/** A bare array of sections ({name, blocks}) is a block spec without its wrapper. */
function asPlan(value: unknown): unknown {
  if (isPlanObject(value)) return value;
  if (Array.isArray(value) && value.length && value.every((item) => isRecord(item) && (Array.isArray(item.blocks) || Array.isArray(item.children)))) {
    return { sections: value };
  }
  if (isRecord(value)) {
    for (const key of WRAPPER_KEYS) {
      const found = extractPlanJson(value[key]);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Free models often return almost-JSON: // or /* *\/ comments and trailing commas. Repair those outside string literals and parse again (2026-11-07: a 4.7k-char
 * compact answer with finish_reason=stop was thrown away as "no extractable design JSON").
 */
export function parseLenientJson(input: string): unknown {
  let out = "";
  let inString = false;
  let escaped = false;
  const text = input;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else if (char === "\n") out = out.slice(0, -1) + "\\n";
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    if (char === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (char === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    // Trailing comma before a closing bracket (outside strings only).
    if (char === "}" || char === "]") out = out.replace(/,\s*$/, "");
    out += char;
  }
  return JSON.parse(out) as unknown;
}

function parseJsonText(input: string): unknown {
  // Reasoning models may put a <think> block (with braces of its own) before the answer.
  const text = input.trim().replace(/^\uFEFF/, "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) return null;

  try {
    const direct = asPlan(JSON.parse(text) as unknown);
    if (direct !== null) return direct;
  } catch {
    // The provider may have wrapped JSON in a markdown fence or a short preamble.
  }

  const unfenced = text
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/i, "")
    .trim();
  if (unfenced !== text) {
    try {
      const fenced = asPlan(JSON.parse(unfenced) as unknown);
      if (fenced !== null) return fenced;
    } catch {
      // Continue with balanced-object extraction.
    }
  }

  // Find the first balanced JSON object while respecting quoted strings and escapes.
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const slice = text.slice(start, index + 1);
          let candidate: unknown = null;
          try { candidate = JSON.parse(slice) as unknown; }
          catch { try { candidate = parseLenientJson(slice); } catch { candidate = null; } }
          const plan = candidate === null ? null : asPlan(candidate);
          if (plan !== null) return plan;
          break;
        }
      }
    }
  }
  return null;
}

/**
 * OpenRouter's OpenAI-compatible response can represent structured output as
 * plain text, an array of text blocks, already-parsed JSON, or function/tool
 * arguments. Normalize those forms into the one native Figma plan shape.
 */
export function extractPlanJson(value: unknown): unknown {
  if (typeof value === "string") return parseJsonText(value);
  if (Array.isArray(value)) {
    for (const part of value) {
      const found = extractPlanJson(part);
      if (found !== null) return found;
    }
    const textParts = value
      .filter((part): part is JsonRecord => isRecord(part) && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
    return textParts ? parseJsonText(textParts) : null;
  }
  if (!isRecord(value)) return null;
  if (isPlanObject(value)) return value;

  // Tool/function calls may contain the entire JSON plan in arguments or input.
  const functionRecord = isRecord(value.function) ? value.function : null;
  for (const candidate of [
    value.data,
    value.result,
    value.response,
    value.responseBody,
    value.generation,
    value.candidates,
    value.parts,
    value.parsed,
    value.json,
    value.output,
    value.output_text,
    value.generatedText,
    value.generated_text,
    value.content,
    value.text,
    value.arguments,
    value.input,
    functionRecord?.arguments,
    ...(Array.isArray(value.tool_calls) ? value.tool_calls : []),
    ...(Array.isArray(value.choices) ? value.choices : []),
    value.message,
  ]) {
    const found = extractPlanJson(candidate);
    if (found !== null) return found;
  }
  return null;
}

export function describeModelContent(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const kinds = value.slice(0, 5).map((part) => isRecord(part) && typeof part.type === "string" ? part.type : typeof part);
    return "array[" + kinds.join(",") + (value.length > 5 ? ",…" : "") + "]";
  }
  if (typeof value === "string") return "string(" + value.length + " chars)";
  if (isRecord(value)) return "object(" + Object.keys(value).slice(0, 8).join(",") + ")";
  return typeof value;
}
