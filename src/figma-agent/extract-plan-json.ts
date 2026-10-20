type JsonRecord = Record<string, unknown>;

type NativePlanLike = JsonRecord & { summary: unknown; frame: unknown; elements: unknown };

const PLAN_KEYS = ["summary", "frame", "elements"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlanObject(value: unknown): value is NativePlanLike {
  return isRecord(value) && PLAN_KEYS.every((key) => key in value);
}

function parseJsonText(input: string): unknown {
  const text = input.trim().replace(/^\uFEFF/, "");
  if (!text) return null;

  try {
    const direct = JSON.parse(text) as unknown;
    if (isPlanObject(direct)) return direct;
    if (isRecord(direct)) {
      for (const key of ["parsed", "json", "output", "content", "text", "arguments", "input"]) {
        const found = extractPlanJson(direct[key]);
        if (found !== null) return found;
      }
    }
  } catch {
    // The provider may have wrapped JSON in a markdown fence or a short preamble.
  }

  const unfenced = text
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/i, "")
    .trim();
  if (unfenced !== text) {
    try {
      const fenced = JSON.parse(unfenced) as unknown;
      if (isPlanObject(fenced)) return fenced;
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
          try {
            const candidate = JSON.parse(text.slice(start, index + 1)) as unknown;
            if (isPlanObject(candidate)) return candidate;
          } catch {
            break;
          }
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
